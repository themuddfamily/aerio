#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <map>
#include <memory>
#include <cstdio>
#include <cstdlib>
#include <string>

// The addon uses only Node-API, not V8/Electron ABI internals. All JS calls run on Cocoa's main thread.
static napi_threadsafe_function callback;
static void Diagnostic(const char *stage) { if (getenv("AERIO_NATIVE_AUDIT")) fprintf(stderr, "[Aerio AppleScript] %s\n", stage); }
struct Request { uint64_t identifier; std::string request; std::string token; };
static uint64_t sequence = 0;
struct Pending { NSAppleEventManagerSuspensionID suspension; };
static std::map<uint64_t, Pending> pending;
static const size_t MAX_REQUEST = 1024 * 1024;
static const size_t MAX_REPLY = 2 * 1024 * 1024;

static std::string Text(napi_env env, napi_value value) {
  napi_valuetype type; if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return {};
  size_t length = 0; napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  if (length > MAX_REPLY) return {};
  std::string result(length + 1, '\0'); napi_get_value_string_utf8(env, value, result.data(), result.size(), &length); result.resize(length); return result;
}
static void Finish(uint64_t identifier, NSString *value) {
  auto found = pending.find(identifier); if (found == pending.end()) return;
  Pending item = found->second; pending.erase(found);
  Diagnostic("reply resumed");
  NSAppleEventDescriptor *reply = [[NSAppleEventManager sharedAppleEventManager] replyAppleEventForSuspensionID:item.suspension];
  [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:value] forKeyword:keyDirectObject];
  [[NSAppleEventManager sharedAppleEventManager] resumeWithSuspensionID:item.suspension];
}
static NSString *Error(NSString *code, NSString *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"ok": @NO, @"error": @{@"code": code, @"message": message}} options:0 error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
// Node owns this callback scope and drains Promise continuations when it returns.
// Cocoa delivery must enqueue onto Node rather than call JS from an Apple-event stack.
static void Dispatch(napi_env env, napi_value function, void *, void *data) {
  std::unique_ptr<Request> request(static_cast<Request *>(data));
  if (!env || !function || pending.find(request->identifier) == pending.end()) return;
  Diagnostic("JS callback dispatched");
  napi_value global, ignored, args[3]; napi_get_global(env, &global);
  napi_create_double(env, (double)request->identifier, &args[0]);
  napi_create_string_utf8(env, request->request.data(), request->request.size(), &args[1]);
  napi_create_string_utf8(env, request->token.data(), request->token.size(), &args[2]);
  napi_status status = napi_call_function(env, global, function, 3, args, &ignored);
  if (status != napi_ok) { bool exception = false; napi_is_exception_pending(env, &exception); if (exception) napi_get_and_clear_last_exception(env, &ignored); Finish(request->identifier, Error(@"failed", @"Aerio could not handle this automation request.")); }
}
@interface AerioAppleEventHandler : NSObject
- (void)call:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply;
@end
@implementation AerioAppleEventHandler
- (void)call:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
  @autoreleasepool {
    Diagnostic("Apple event received");
    NSString *request = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    NSString *token = [[event paramDescriptorForKeyword:'tokn'] stringValue];
    if (!callback || !request || !token || [request lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > MAX_REQUEST || token.length > 200 || pending.size() >= 16) {
      [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:Error(@"invalid-arguments", @"Invalid or excessive AppleScript requests.")] forKeyword:keyDirectObject]; return;
    }
    NSAppleEventManagerSuspensionID suspension = [[NSAppleEventManager sharedAppleEventManager] suspendCurrentAppleEvent];
    if (!suspension) { [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:Error(@"failed", @"Apple event could not be suspended.")] forKeyword:keyDirectObject]; return; }
    uint64_t identifier = ++sequence; pending.emplace(identifier, Pending{suspension});
    Request *queued = new Request{identifier, request.UTF8String ?: "", token.UTF8String ?: ""};
    if (napi_call_threadsafe_function(callback, queued, napi_tsfn_nonblocking) != napi_ok) {
      delete queued; Finish(identifier, Error(@"failed", @"Aerio could not enqueue this automation request."));
    } else Diagnostic("Apple event enqueued");
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ Finish(identifier, Error(@"timeout", @"AppleScript request timed out. Check Aerio before retrying a write or send.")); });
  }
}
@end
static AerioAppleEventHandler *handler;
static void Stop(void *) {
  [[NSAppleEventManager sharedAppleEventManager] removeEventHandlerForEventClass:'AerI' andEventID:'call'];
  while (!pending.empty()) Finish(pending.begin()->first, Error(@"failed", @"Aerio is shutting down."));
  if (callback) { napi_release_threadsafe_function(callback, napi_tsfn_abort); callback = nullptr; }
  handler = nil;
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], result; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_valuetype type; if (count != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function || ![NSThread isMainThread]) { napi_throw_error(env, nullptr, "Apple events require a callback on the main thread"); return nullptr; }
  Stop(nullptr);
  napi_value name; napi_create_string_utf8(env, "AerioAppleEvents", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[0], nullptr, name, 16, 1, nullptr, nullptr, nullptr, Dispatch, &callback) != napi_ok) { napi_throw_error(env, nullptr, "Apple event callback registration failed"); return nullptr; }
  napi_unref_threadsafe_function(env, callback);
  handler = [AerioAppleEventHandler new];
  [[NSAppleEventManager sharedAppleEventManager] setEventHandler:handler andSelector:@selector(call:withReplyEvent:) forEventClass:'AerI' andEventID:'call'];
  Diagnostic("handler registered");
  napi_get_undefined(env, &result); return result;
}
static napi_value Complete(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2], result; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  double identifier = 0; if (count == 2 && napi_get_value_double(env, args[0], &identifier) == napi_ok) {
    std::string text = Text(env, args[1]);
    Finish((uint64_t)identifier, text.empty() ? Error(@"too-large", @"AppleScript result exceeded the supported size.") : [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding]);
  }
  napi_get_undefined(env, &result); return result;
}
static napi_value Close(napi_env env, napi_callback_info) { Stop(nullptr); napi_value result; napi_get_undefined(env, &result); return result; }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {{"start", 0, Start, 0, 0, 0, napi_default, 0}, {"complete", 0, Complete, 0, 0, 0, napi_default, 0}, {"close", 0, Close, 0, 0, 0, napi_default, 0}};
  napi_define_properties(env, exports, 3, properties); napi_add_env_cleanup_hook(env, Stop, nullptr); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
