#import <Cocoa/Cocoa.h>
#import <CoreSpotlight/CoreSpotlight.h>
#include <node_api.h>
#include <string>

static bool alive = true;
static NSMutableSet<CSSearchQuery *> *queries;
static std::string Text(napi_env env, napi_value value) {
  napi_valuetype type; if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return {};
  size_t length = 0; napi_get_value_string_utf8(env, value, nullptr, 0, &length); if (length > 2 * 1024 * 1024) return {};
  std::string result(length + 1, '\0'); napi_get_value_string_utf8(env, value, result.data(), result.size(), &length); result.resize(length); return result;
}
static void Reply(napi_env env, napi_deferred deferred, id value, NSError *error) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!alive) return;
    napi_handle_scope scope; napi_open_handle_scope(env, &scope); napi_value result;
    if (error) {
      napi_value message; napi_create_string_utf8(env, "macOS Spotlight could not complete this operation. Check Spotlight availability and retry.", NAPI_AUTO_LENGTH, &message); napi_create_error(env, nullptr, message, &result); napi_reject_deferred(env, deferred, result);
    } else {
      NSData *data = [NSJSONSerialization dataWithJSONObject:value ?: @{} options:NSJSONWritingFragmentsAllowed error:nil];
      NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
      napi_create_string_utf8(env, json.UTF8String ?: "{}", NAPI_AUTO_LENGTH, &result); napi_resolve_deferred(env, deferred, result);
    }
    napi_close_handle_scope(env, scope);
  });
}
static napi_value Perform(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2], promise; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || ![NSThread isMainThread]) { napi_throw_type_error(env, nullptr, "Spotlight requires operation JSON on the main thread"); return nullptr; }
  std::string operation = Text(env, args[0]), text = Text(env, args[1]);
  NSData *bytes = [NSData dataWithBytes:text.data() length:text.size()];
  id input = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  NSString *domain = [input isKindOfClass:NSDictionary.class] ? input[@"domain"] : nil;
  if (![domain isKindOfClass:NSString.class] || domain.length > 160 || ![domain hasPrefix:@"com.aerio.spotlight."] || ![CSSearchableIndex isIndexingAvailable]) { napi_throw_error(env, nullptr, "Spotlight is unavailable or its domain is invalid"); return nullptr; }
  napi_deferred deferred; napi_create_promise(env, &deferred, &promise);
  CSSearchableIndex *index = [CSSearchableIndex defaultSearchableIndex];
  if (operation == "delete") {
    [index deleteSearchableItemsWithDomainIdentifiers:@[domain] completionHandler:^(NSError *error) { Reply(env, deferred, @{}, error); }];
  } else if (operation == "index") {
    NSArray *rows = input[@"items"];
    if (![rows isKindOfClass:NSArray.class] || rows.count > 250) { Reply(env, deferred, nil, [NSError errorWithDomain:@"Aerio" code:1 userInfo:nil]); return promise; }
    NSMutableArray<CSSearchableItem *> *items = [NSMutableArray new];
    for (id row in rows) {
      if (![row isKindOfClass:NSDictionary.class]) continue;
      NSString *identifier = row[@"id"], *title = row[@"title"], *sender = row[@"sender"], *preview = row[@"preview"];
      if (![identifier isKindOfClass:NSString.class] || identifier.length > 80 || ![title isKindOfClass:NSString.class] || title.length > 500) continue;
      CSSearchableItemAttributeSet *attributes = [[CSSearchableItemAttributeSet alloc] initWithItemContentType:@"public.email-message"];
      attributes.title = title; attributes.displayName = title; attributes.keywords = @[@"Aerio", @"Mail"];
      if ([sender isKindOfClass:NSString.class] && sender.length <= 320) attributes.authors = @[sender];
      if ([preview isKindOfClass:NSString.class] && preview.length <= 500) attributes.contentDescription = preview;
      attributes.contentURL = [NSURL URLWithString:[@"aerio://spotlight/" stringByAppendingString:identifier]];
      CSSearchableItem *item = [[CSSearchableItem alloc] initWithUniqueIdentifier:identifier domainIdentifier:domain attributeSet:attributes];
      item.expirationDate = [NSDate dateWithTimeIntervalSinceNow:7 * 24 * 60 * 60]; [items addObject:item];
    }
    [index indexSearchableItems:items completionHandler:^(NSError *error) { Reply(env, deferred, @{@"count": @(items.count)}, error); }];
  } else if (operation == "query") {
    // Main-process native validation uses an exact title; this method is not exposed over renderer IPC.
    NSString *title = input[@"title"];
    if (![title isKindOfClass:NSString.class] || title.length > 500) { Reply(env, deferred, nil, [NSError errorWithDomain:@"Aerio" code:1 userInfo:nil]); return promise; }
    NSString *escaped = [[title stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"] stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    CSSearchQuery *query = [[CSSearchQuery alloc] initWithQueryString:[NSString stringWithFormat:@"title == \"%@\"c", escaped] attributes:@[@"title"]];
    NSMutableArray<NSString *> *found = [NSMutableArray new];
    __weak CSSearchQuery *weakQuery = query;
    query.foundItemsHandler = ^(NSArray<CSSearchableItem *> *items) { @synchronized(found) { for (CSSearchableItem *item in items) if ([item.domainIdentifier isEqualToString:domain] && found.count < 1000) [found addObject:item.uniqueIdentifier]; } };
    query.completionHandler = ^(NSError *error) { @synchronized(found) { Reply(env, deferred, [found copy], error); } dispatch_async(dispatch_get_main_queue(), ^{ [queries removeObject:weakQuery]; }); };
    [queries addObject:query]; [query start];
  } else { Reply(env, deferred, nil, [NSError errorWithDomain:@"Aerio" code:1 userInfo:nil]); }
  return promise;
}
static void Cleanup(void *) { alive = false; for (CSSearchQuery *query in queries) [query cancel]; [queries removeAllObjects]; }
static napi_value Init(napi_env env, napi_value exports) {
  alive = true; queries = [NSMutableSet new];
  napi_property_descriptor properties[] = {{"perform", 0, Perform, 0, 0, 0, napi_default, 0}}; napi_define_properties(env, exports, 1, properties);
  napi_value available; napi_get_boolean(env, [CSSearchableIndex isIndexingAvailable], &available); napi_set_named_property(env, exports, "available", available);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
