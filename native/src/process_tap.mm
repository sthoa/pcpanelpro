// PC Panel Pro - Per-App Audio Capture via Core Audio Process Taps (macOS 14.4+)
//
// Each channel taps the audio of one or more processes (muting them at the
// system output) and replays the tapped audio through the real output device
// with a hardware-controlled gain. This is how per-app volume control works
// without virtual devices.

#include <napi.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreAudio/AudioHardwareTapping.h>
#include <CoreAudio/CATapDescription.h>
#include <libproc.h>
#include <unistd.h>
#import <IOKit/hidsystem/ev_keymap.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// Private-but-stable libsystem call used to map helper processes (e.g. a
// browser's GPU process) back to the app the user actually recognizes.
extern "C" pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);

// Defined in audio_passthrough.mm
AudioDeviceID getDefaultOutputDevice();

namespace {

// =============================================================================
// Core Audio helpers
// =============================================================================

NSString* copyDeviceUID(AudioDeviceID deviceID) {
    AudioObjectPropertyAddress addr = {
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    CFStringRef uid = nullptr;
    UInt32 size = sizeof(uid);
    OSStatus status = AudioObjectGetPropertyData(deviceID, &addr, 0, nullptr, &size, &uid);
    if (status != noErr || !uid) {
        return nil;
    }
    return (__bridge_transfer NSString*)uid;
}

AudioObjectID translatePIDToProcessObject(pid_t pid) {
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyTranslatePIDToProcessObject,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    AudioObjectID processObject = kAudioObjectUnknown;
    UInt32 size = sizeof(processObject);
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr,
                                                 sizeof(pid), &pid, &size, &processObject);
    if (status != noErr) {
        return kAudioObjectUnknown;
    }
    return processObject;
}

std::vector<AudioObjectID> copyProcessObjectList() {
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size);
    if (status != noErr || size == 0) {
        return {};
    }
    std::vector<AudioObjectID> objects(size / sizeof(AudioObjectID));
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, objects.data());
    if (status != noErr) {
        return {};
    }
    objects.resize(size / sizeof(AudioObjectID));
    return objects;
}

pid_t getProcessPID(AudioObjectID processObject) {
    AudioObjectPropertyAddress addr = {
        kAudioProcessPropertyPID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    pid_t pid = -1;
    UInt32 size = sizeof(pid);
    if (AudioObjectGetPropertyData(processObject, &addr, 0, nullptr, &size, &pid) != noErr) {
        return -1;
    }
    return pid;
}

std::string getProcessBundleID(AudioObjectID processObject) {
    AudioObjectPropertyAddress addr = {
        kAudioProcessPropertyBundleID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    CFStringRef bundleID = nullptr;
    UInt32 size = sizeof(bundleID);
    if (AudioObjectGetPropertyData(processObject, &addr, 0, nullptr, &size, &bundleID) != noErr || !bundleID) {
        return "";
    }
    NSString* str = (__bridge_transfer NSString*)bundleID;
    return std::string([str UTF8String] ?: "");
}

bool isProcessRunningOutput(AudioObjectID processObject) {
    AudioObjectPropertyAddress addr = {
        kAudioProcessPropertyIsRunningOutput,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 running = 0;
    UInt32 size = sizeof(running);
    if (AudioObjectGetPropertyData(processObject, &addr, 0, nullptr, &size, &running) != noErr) {
        return false;
    }
    return running != 0;
}

std::string getProcessName(pid_t pid) {
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (app && app.localizedName) {
        return std::string([app.localizedName UTF8String] ?: "");
    }
    char nameBuf[2 * MAXCOMLEN] = {0};
    if (proc_name(pid, nameBuf, sizeof(nameBuf)) > 0) {
        return std::string(nameBuf);
    }
    return "";
}

std::string getAppBundleID(pid_t pid) {
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (app && app.bundleIdentifier) {
        return std::string([app.bundleIdentifier UTF8String] ?: "");
    }
    return "";
}

// =============================================================================
// TapChannel - one process tap + private aggregate playing to the real output
// =============================================================================

class TapChannel {
public:
    TapChannel() = default;

    ~TapChannel() {
        stop();
    }

    bool start(const std::vector<pid_t>& pids, bool exclusive, AudioDeviceID outputDevice,
               const std::string& label) {
        stop();

        if (outputDevice == kAudioObjectUnknown) {
            outputDevice = getDefaultOutputDevice();
        }
        if (outputDevice == kAudioObjectUnknown) {
            fprintf(stderr, "[TapChannel %s] No output device\n", label.c_str());
            return false;
        }

        // Resolve pids to Core Audio process objects
        NSMutableArray<NSNumber*>* processObjects = [NSMutableArray array];
        std::vector<pid_t> tappedPids;
        for (pid_t pid : pids) {
            AudioObjectID obj = translatePIDToProcessObject(pid);
            if (obj != kAudioObjectUnknown) {
                [processObjects addObject:@(obj)];
                tappedPids.push_back(pid);
            }
        }

        if (exclusive) {
            // Never tap ourselves: we are the one replaying the audio, so a
            // global tap that included us would mute our own playback.
            AudioObjectID selfObj = translatePIDToProcessObject(getpid());
            if (selfObj != kAudioObjectUnknown && ![processObjects containsObject:@(selfObj)]) {
                [processObjects addObject:@(selfObj)];
            }
        } else if (processObjects.count == 0) {
            fprintf(stderr, "[TapChannel %s] No audio process objects for given pids\n", label.c_str());
            return false;
        }

        CATapDescription* desc;
        if (exclusive) {
            desc = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:processObjects];
        } else {
            desc = [[CATapDescription alloc] initStereoMixdownOfProcesses:processObjects];
        }
        desc.name = [NSString stringWithFormat:@"PCPanel Tap %s", label.c_str()];
        desc.muteBehavior = CATapMutedWhenTapped;
        [desc setPrivate:YES];

        OSStatus status = AudioHardwareCreateProcessTap(desc, &tap_);
        if (status != noErr || tap_ == kAudioObjectUnknown) {
            fprintf(stderr, "[TapChannel %s] AudioHardwareCreateProcessTap failed: %d\n",
                    label.c_str(), (int)status);
            tap_ = kAudioObjectUnknown;
            return false;
        }

        NSString* outputUID = copyDeviceUID(outputDevice);
        if (!outputUID) {
            fprintf(stderr, "[TapChannel %s] Failed to get output device UID\n", label.c_str());
            stop();
            return false;
        }

        NSString* aggregateUID = [[NSUUID UUID] UUIDString];
        NSDictionary* description = @{
            @(kAudioAggregateDeviceUIDKey): aggregateUID,
            @(kAudioAggregateDeviceNameKey): [NSString stringWithFormat:@"PCPanel %s", label.c_str()],
            @(kAudioAggregateDeviceMainSubDeviceKey): outputUID,
            @(kAudioAggregateDeviceIsPrivateKey): @YES,
            @(kAudioAggregateDeviceIsStackedKey): @NO,
            @(kAudioAggregateDeviceTapAutoStartKey): @YES,
            @(kAudioAggregateDeviceSubDeviceListKey): @[
                @{ @(kAudioSubDeviceUIDKey): outputUID }
            ],
            @(kAudioAggregateDeviceTapListKey): @[
                @{
                    @(kAudioSubTapDriftCompensationKey): @YES,
                    @(kAudioSubTapUIDKey): [desc.UUID UUIDString]
                }
            ]
        };

        status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)description, &aggregate_);
        if (status != noErr || aggregate_ == kAudioObjectUnknown) {
            fprintf(stderr, "[TapChannel %s] AudioHardwareCreateAggregateDevice failed: %d\n",
                    label.c_str(), (int)status);
            aggregate_ = kAudioObjectUnknown;
            stop();
            return false;
        }

        status = AudioDeviceCreateIOProcID(aggregate_, IOProc, this, &procID_);
        if (status != noErr) {
            fprintf(stderr, "[TapChannel %s] Failed to create IOProc: %d\n", label.c_str(), (int)status);
            procID_ = nullptr;
            stop();
            return false;
        }

        status = AudioDeviceStart(aggregate_, procID_);
        if (status != noErr) {
            fprintf(stderr, "[TapChannel %s] Failed to start IOProc: %d\n", label.c_str(), (int)status);
            stop();
            return false;
        }

        label_ = label;
        exclusive_ = exclusive;
        tappedPids_ = tappedPids;
        outputDevice_ = outputDevice;
        running_ = true;
        fprintf(stderr, "[TapChannel %s] Started (%s, %zu pids, output %u)\n",
                label.c_str(), exclusive ? "exclusive" : "mixdown", tappedPids.size(), outputDevice);
        return true;
    }

    void stop() {
        running_ = false;

        if (procID_) {
            AudioDeviceStop(aggregate_, procID_);
            AudioDeviceDestroyIOProcID(aggregate_, procID_);
            procID_ = nullptr;
        }
        if (aggregate_ != kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregate_);
            aggregate_ = kAudioObjectUnknown;
        }
        if (tap_ != kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tap_);
            tap_ = kAudioObjectUnknown;
        }
        tappedPids_.clear();
    }

    void setGain(float gain) {
        gain_.store(std::max(0.0f, std::min(1.0f, gain)));
    }

    void setMuted(bool muted) {
        muted_.store(muted);
    }

    bool isRunning() const { return running_.load(); }
    bool isExclusive() const { return exclusive_; }
    float getGain() const { return gain_.load(); }
    bool getMuted() const { return muted_.load(); }
    AudioDeviceID getOutputDevice() const { return outputDevice_; }
    const std::vector<pid_t>& getTappedPids() const { return tappedPids_; }

    float getPeak() const { return peakLevel_.load(std::memory_order_relaxed); }
    float getRMS() const { return rmsLevel_.load(std::memory_order_relaxed); }

    bool hasActivity() const {
        auto now = std::chrono::steady_clock::now().time_since_epoch().count();
        return (now - lastActivityTime_.load()) < 500000000LL;  // 500ms
    }

private:
    static OSStatus IOProc(AudioObjectID /* device */,
                           const AudioTimeStamp* /* now */,
                           const AudioBufferList* inputData,
                           const AudioTimeStamp* /* inputTime */,
                           AudioBufferList* outputData,
                           const AudioTimeStamp* /* outputTime */,
                           void* clientData) {
        auto* self = static_cast<TapChannel*>(clientData);

        if (!outputData || outputData->mNumberBuffers == 0) {
            return noErr;
        }

        // Zero all output buffers first
        for (UInt32 b = 0; b < outputData->mNumberBuffers; b++) {
            AudioBuffer& out = outputData->mBuffers[b];
            if (out.mData && out.mDataByteSize > 0) {
                memset(out.mData, 0, out.mDataByteSize);
            }
        }

        if (!inputData || inputData->mNumberBuffers == 0) {
            return noErr;
        }

        const AudioBuffer& in = inputData->mBuffers[0];
        if (!in.mData || in.mDataByteSize == 0) {
            return noErr;
        }

        const Float32* inSamples = static_cast<const Float32*>(in.mData);
        UInt32 inChannels = in.mNumberChannels > 0 ? in.mNumberChannels : 2;
        UInt32 inFrames = in.mDataByteSize / sizeof(Float32) / inChannels;

        // Levels + activity measured pre-gain so meters work even at volume 0
        float peak = 0.0f;
        float sumSquares = 0.0f;
        UInt32 totalSamples = inFrames * inChannels;
        for (UInt32 i = 0; i < totalSamples; i++) {
            float absVal = std::fabs(inSamples[i]);
            if (absVal > peak) peak = absVal;
            sumSquares += inSamples[i] * inSamples[i];
        }
        float rms = totalSamples > 0 ? std::sqrt(sumSquares / totalSamples) : 0.0f;
        self->peakLevel_.store(peak, std::memory_order_relaxed);
        self->rmsLevel_.store(rms, std::memory_order_relaxed);
        if (peak > 0.001f) {
            self->lastActivityTime_.store(
                std::chrono::steady_clock::now().time_since_epoch().count());
        }

        float gain = self->muted_.load() ? 0.0f : self->gain_.load();
        if (gain <= 0.0f) {
            return noErr;  // Output already zeroed
        }

        AudioBuffer& out = outputData->mBuffers[0];
        if (!out.mData || out.mDataByteSize == 0) {
            return noErr;
        }

        Float32* outSamples = static_cast<Float32*>(out.mData);
        UInt32 outChannels = out.mNumberChannels > 0 ? out.mNumberChannels : 2;
        UInt32 outFrames = out.mDataByteSize / sizeof(Float32) / outChannels;
        UInt32 frames = std::min(inFrames, outFrames);

        for (UInt32 f = 0; f < frames; f++) {
            for (UInt32 c = 0; c < outChannels; c++) {
                // Map extra output channels from the available input channels
                UInt32 ic = c < inChannels ? c : inChannels - 1;
                outSamples[f * outChannels + c] = inSamples[f * inChannels + ic] * gain;
            }
        }

        return noErr;
    }

    AudioObjectID tap_ = kAudioObjectUnknown;
    AudioObjectID aggregate_ = kAudioObjectUnknown;
    AudioDeviceIOProcID procID_ = nullptr;
    AudioDeviceID outputDevice_ = kAudioObjectUnknown;
    std::string label_;
    bool exclusive_ = false;
    std::vector<pid_t> tappedPids_;
    std::atomic<bool> running_{false};
    std::atomic<float> gain_{1.0f};
    std::atomic<bool> muted_{false};
    std::atomic<float> peakLevel_{0.0f};
    std::atomic<float> rmsLevel_{0.0f};
    std::atomic<int64_t> lastActivityTime_{0};
};

std::map<std::string, std::unique_ptr<TapChannel>> g_tapChannels;
std::mutex g_tapMutex;

}  // namespace

// =============================================================================
// N-API wrappers
// =============================================================================

// tapListProcesses() -> [{ pid, bundleID, name, responsiblePid, responsibleBundleID,
//                          responsibleName, isRunningOutput, isSelf }]
static Napi::Value TapListProcesses(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    @autoreleasepool {
        Napi::Array result = Napi::Array::New(env);
        uint32_t index = 0;
        pid_t selfPid = getpid();
        pid_t selfResponsible = responsibility_get_pid_responsible_for_pid(selfPid);

        for (AudioObjectID obj : copyProcessObjectList()) {
            pid_t pid = getProcessPID(obj);
            if (pid <= 0) {
                continue;
            }

            pid_t responsiblePid = responsibility_get_pid_responsible_for_pid(pid);
            if (responsiblePid <= 0) {
                responsiblePid = pid;
            }

            bool isSelf = (pid == selfPid) || (responsiblePid == selfPid) ||
                          (selfResponsible > 0 && responsiblePid == selfResponsible);

            // Regular apps (shown in the Dock) vs daemons/menu-bar-only agents
            NSRunningApplication* responsibleApp =
                [NSRunningApplication runningApplicationWithProcessIdentifier:responsiblePid];
            bool isRegularApp = responsibleApp != nil &&
                responsibleApp.activationPolicy == NSApplicationActivationPolicyRegular;

            Napi::Object proc = Napi::Object::New(env);
            proc.Set("pid", Napi::Number::New(env, pid));
            proc.Set("bundleID", Napi::String::New(env, getProcessBundleID(obj)));
            proc.Set("name", Napi::String::New(env, getProcessName(pid)));
            proc.Set("responsiblePid", Napi::Number::New(env, responsiblePid));
            proc.Set("responsibleBundleID", Napi::String::New(env, getAppBundleID(responsiblePid)));
            proc.Set("responsibleName", Napi::String::New(env, getProcessName(responsiblePid)));
            proc.Set("isRunningOutput", Napi::Boolean::New(env, isProcessRunningOutput(obj)));
            proc.Set("isSelf", Napi::Boolean::New(env, isSelf));
            proc.Set("isRegularApp", Napi::Boolean::New(env, isRegularApp));
            result[index++] = proc;
        }

        return result;
    }
}

// tapGetAppIcon(pid) -> data URL string or null
static Napi::Value TapGetAppIcon(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "pid required").ThrowAsJavaScriptException();
        return env.Null();
    }

    @autoreleasepool {
        pid_t pid = static_cast<pid_t>(info[0].As<Napi::Number>().Int32Value());
        NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        if (!app || !app.icon) {
            return env.Null();
        }

        NSImage* icon = app.icon;
        NSRect rect = NSMakeRect(0, 0, 64, 64);
        CGImageRef cgImage = [icon CGImageForProposedRect:&rect context:nil hints:nil];
        if (!cgImage) {
            return env.Null();
        }

        NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
        NSData* pngData = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!pngData) {
            return env.Null();
        }

        NSString* base64 = [pngData base64EncodedStringWithOptions:0];
        std::string dataURL = "data:image/png;base64," + std::string([base64 UTF8String] ?: "");
        return Napi::String::New(env, dataURL);
    }
}

// tapCreateChannel(channelId, pids[], exclusive, outputDeviceId?) -> bool
// Replaces any existing tap for the channel. Gain/mute are preserved.
static Napi::Value TapCreateChannel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsArray() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env, "channelId, pids array, and exclusive flag required")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string channelId = info[0].As<Napi::String>().Utf8Value();
    Napi::Array pidArray = info[1].As<Napi::Array>();
    bool exclusive = info[2].As<Napi::Boolean>().Value();

    AudioDeviceID outputDevice = kAudioObjectUnknown;
    if (info.Length() >= 4 && info[3].IsNumber()) {
        outputDevice = static_cast<AudioDeviceID>(info[3].As<Napi::Number>().Uint32Value());
    }

    std::vector<pid_t> pids;
    for (uint32_t i = 0; i < pidArray.Length(); i++) {
        Napi::Value v = pidArray[i];
        if (v.IsNumber()) {
            pids.push_back(static_cast<pid_t>(v.As<Napi::Number>().Int32Value()));
        }
    }

    @autoreleasepool {
        std::lock_guard<std::mutex> lock(g_tapMutex);

        float gain = 1.0f;
        bool muted = false;
        auto it = g_tapChannels.find(channelId);
        if (it != g_tapChannels.end()) {
            gain = it->second->getGain();
            muted = it->second->getMuted();
        }

        auto channel = std::make_unique<TapChannel>();
        channel->setGain(gain);
        channel->setMuted(muted);
        if (!channel->start(pids, exclusive, outputDevice, channelId)) {
            return Napi::Boolean::New(env, false);
        }

        g_tapChannels[channelId] = std::move(channel);
        return Napi::Boolean::New(env, true);
    }
}

// tapDestroyChannel(channelId) -> bool
static Napi::Value TapDestroyChannel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "channelId required").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string channelId = info[0].As<Napi::String>().Utf8Value();

    @autoreleasepool {
        std::lock_guard<std::mutex> lock(g_tapMutex);
        auto it = g_tapChannels.find(channelId);
        if (it == g_tapChannels.end()) {
            return Napi::Boolean::New(env, false);
        }
        g_tapChannels.erase(it);
        return Napi::Boolean::New(env, true);
    }
}

// tapSetGain(channelId, gain) -> bool
static Napi::Value TapSetGain(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "channelId and gain required").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string channelId = info[0].As<Napi::String>().Utf8Value();
    float gain = info[1].As<Napi::Number>().FloatValue();

    std::lock_guard<std::mutex> lock(g_tapMutex);
    auto it = g_tapChannels.find(channelId);
    if (it == g_tapChannels.end()) {
        return Napi::Boolean::New(env, false);
    }
    it->second->setGain(gain);
    return Napi::Boolean::New(env, true);
}

// tapSetMuted(channelId, muted) -> bool
static Napi::Value TapSetMuted(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "channelId and muted required").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string channelId = info[0].As<Napi::String>().Utf8Value();
    bool muted = info[1].As<Napi::Boolean>().Value();

    std::lock_guard<std::mutex> lock(g_tapMutex);
    auto it = g_tapChannels.find(channelId);
    if (it == g_tapChannels.end()) {
        return Napi::Boolean::New(env, false);
    }
    it->second->setMuted(muted);
    return Napi::Boolean::New(env, true);
}

// tapGetStatus() -> { [channelId]: { running, exclusive, gain, muted, peak, rms,
//                                    active, pids, outputDeviceId } }
static Napi::Value TapGetStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    std::lock_guard<std::mutex> lock(g_tapMutex);

    Napi::Object result = Napi::Object::New(env);
    for (const auto& [channelId, channel] : g_tapChannels) {
        Napi::Object status = Napi::Object::New(env);
        status.Set("running", Napi::Boolean::New(env, channel->isRunning()));
        status.Set("exclusive", Napi::Boolean::New(env, channel->isExclusive()));
        status.Set("gain", Napi::Number::New(env, channel->getGain()));
        status.Set("muted", Napi::Boolean::New(env, channel->getMuted()));
        status.Set("peak", Napi::Number::New(env, channel->getPeak()));
        status.Set("rms", Napi::Number::New(env, channel->getRMS()));
        status.Set("active", Napi::Boolean::New(env, channel->hasActivity()));
        status.Set("outputDeviceId", Napi::Number::New(env, channel->getOutputDevice()));

        Napi::Array pids = Napi::Array::New(env);
        uint32_t i = 0;
        for (pid_t pid : channel->getTappedPids()) {
            pids[i++] = Napi::Number::New(env, pid);
        }
        status.Set("pids", pids);

        result.Set(channelId, status);
    }

    return result;
}

// tapStopAll() -> bool
static Napi::Value TapStopAll(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    @autoreleasepool {
        std::lock_guard<std::mutex> lock(g_tapMutex);
        g_tapChannels.clear();
        return Napi::Boolean::New(env, true);
    }
}

// sendMediaKey(action) -> bool; 0 = play/pause, 1 = next, 2 = previous.
// Posts the same system-defined HID events a keyboard media key generates,
// so macOS routes them to the active "Now Playing" app.
static Napi::Value SendMediaKey(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "media key action required").ThrowAsJavaScriptException();
        return env.Null();
    }

    int action = info[0].As<Napi::Number>().Int32Value();
    int keyType;
    switch (action) {
        case 1:  keyType = NX_KEYTYPE_NEXT; break;
        case 2:  keyType = NX_KEYTYPE_PREVIOUS; break;
        default: keyType = NX_KEYTYPE_PLAY; break;
    }

    @autoreleasepool {
        for (int down = 1; down >= 0; down--) {
            NSInteger keyState = down ? 0x0A : 0x0B;
            NSEvent* event = [NSEvent otherEventWithType:NSEventTypeSystemDefined
                                                location:NSZeroPoint
                                           modifierFlags:(down ? 0xA00 : 0xB00)
                                               timestamp:0
                                            windowNumber:0
                                                 context:nil
                                                 subtype:8
                                                   data1:((keyType << 16) | (keyState << 8))
                                                   data2:-1];
            CGEventRef cgEvent = event.CGEvent;
            if (!cgEvent) {
                return Napi::Boolean::New(env, false);
            }
            CGEventPost(kCGHIDEventTap, cgEvent);
        }
    }

    return Napi::Boolean::New(env, true);
}

Napi::Object InitProcessTap(Napi::Env env, Napi::Object exports) {
    exports.Set("tapListProcesses", Napi::Function::New(env, TapListProcesses));
    exports.Set("tapGetAppIcon", Napi::Function::New(env, TapGetAppIcon));
    exports.Set("tapCreateChannel", Napi::Function::New(env, TapCreateChannel));
    exports.Set("tapDestroyChannel", Napi::Function::New(env, TapDestroyChannel));
    exports.Set("tapSetGain", Napi::Function::New(env, TapSetGain));
    exports.Set("tapSetMuted", Napi::Function::New(env, TapSetMuted));
    exports.Set("tapGetStatus", Napi::Function::New(env, TapGetStatus));
    exports.Set("tapStopAll", Napi::Function::New(env, TapStopAll));
    exports.Set("sendMediaKey", Napi::Function::New(env, SendMediaKey));
    return exports;
}
