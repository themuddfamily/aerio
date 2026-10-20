#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <map>
#include <string>

// The addon uses only Node-API, not V8/Electron ABI internals. All JS calls run on Cocoa's main thread.
static napi_env environment;
static napi_ref callback;
static uint64_t sequence = 0;
struct Pending { NSAppleEventManagerSuspensionID suspension; };
static std::map<uint64_t, Pending> pending;
static const size_t MAX_REQUEST = 1024 * 1024;
static const size_t MAX_REPLY = 2 * 1024 * 1024;

static napi_value String(napi_env env, NSString *value) {
  napi_value result; const char *utf8 = value.UTF8String ?: ""; napi_create_string_utf8(env, utf8, NAPI_AUTO_LENGTH, &result); return result;
}
static std::string Text(napi_env env, napi_value value) {
  napi_valuetype type; if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return {};
  size_t length = 0; napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  if (length > MAX_REPLY) return {};
  std::string result(length + 1, '\0'); napi_get_value_string_utf8(env, value, result.data(), result.size(), &length); result.resize(length); return result;
}
static void Finish(uint64_t identifier, NSString *value) {
  auto found = pending.find(identifier); if (found == pending.end()) return;
  Pending item = found->second; pending.erase(found);
  NSAppleEventDescriptor *reply = [[NSAppleEventManager sharedAppleEventManager] replyAppleEventForSuspensionID:item.suspension];
  [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:value] forKeyword:keyDirectObject];
  [[NSAppleEventManager sharedAppleEventManager] resumeWithSuspensionID:item.suspension];
}
static NSString *Error(NSString *code, NSString *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"ok": @NO, @"error": @{@"code": code, @"message": message}} options:0 error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
@interface AerioAppleEventHandler : NSObject
- (void)call:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply;
@end
@implementation AerioAppleEventHandler
- (void)call:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
  @autoreleasepool {
    NSString *request = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    NSString *token = [[event paramDescriptorForKeyword:'tokn'] stringValue];
    if (!callback || !request || !token || [request lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > MAX_REQUEST || token.length > 200 || pending.size() >= 16) {
      [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:Error(@"invalid-arguments", @"Invalid or excessive AppleScript requests.")] forKeyword:keyDirectObject]; return;
    }
    NSAppleEventManagerSuspensionID suspension = [[NSAppleEventManager sharedAppleEventManager] suspendCurrentAppleEvent];
    if (!suspension) { [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:Error(@"failed", @"Apple event could not be suspended.")] forKeyword:keyDirectObject]; return; }
    uint64_t identifier = ++sequence; pending.emplace(identifier, Pending{suspension});
    napi_handle_scope scope; napi_open_handle_scope(environment, &scope);
    napi_value function, global, ignored, args[3]; napi_get_reference_value(environment, callback, &function); napi_get_global(environment, &global);
    napi_create_double(environment, (double)identifier, &args[0]); args[1] = String(environment, request); args[2] = String(environment, token);
    napi_status status = napi_call_function(environment, global, function, 3, args, &ignored);
    if (status != napi_ok) { bool exception = false; napi_is_exception_pending(environment, &exception); if (exception) napi_get_and_clear_last_exception(environment, &ignored); Finish(identifier, Error(@"failed", @"Aerio could not handle this automation request.")); }
    napi_close_handle_scope(environment, scope);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ Finish(identifier, Error(@"timeout", @"AppleScript request timed out. Check Aerio before retrying a write or send.")); });
  }
}
@end
static AerioAppleEventHandler *handler;
static void Stop(void *) {
  [[NSAppleEventManager sharedAppleEventManager] removeEventHandlerForEventClass:'AerI' andEventID:'call'];
  while (!pending.empty()) Finish(pending.begin()->first, Error(@"failed", @"Aerio is shutting down."));
  if (callback) { napi_delete_reference(environment, callback); callback = nullptr; }
  handler = nil;
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], result; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_valuetype type; if (count != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function || ![NSThread isMainThread]) { napi_throw_error(env, nullptr, "Apple events require a callback on the main thread"); return nullptr; }
  Stop(nullptr); environment = env; napi_create_reference(env, args[0], 1, &callback);
  handler = [AerioAppleEventHandler new];
  [[NSAppleEventManager sharedAppleEventManager] setEventHandler:handler andSelector:@selector(call:withReplyEvent:) forEventClass:'AerI' andEventID:'call'];
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
  environment = env;
  napi_property_descriptor properties[] = {{"start", 0, Start, 0, 0, 0, napi_default, 0}, {"complete", 0, Complete, 0, 0, 0, napi_default, 0}, {"close", 0, Close, 0, 0, 0, napi_default, 0}};
  napi_define_properties(env, exports, 3, properties); napi_add_env_cleanup_hook(env, Stop, nullptr); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
