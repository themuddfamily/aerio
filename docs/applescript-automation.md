# Inbound AppleScript automation (D32, macOS)

Aerio's macOS bundle includes an AppleScript dictionary and a native Cocoa Apple-event handler. Open **Script Editor → Open Dictionary → Aerio** to inspect **call tool**. This is inbound automation into the running Aerio app, using its existing mail tool service; Aerio does not evaluate shell commands, JavaScript or AppleScript supplied by a caller.

Enable **Settings → External automation**, choose allowed accounts/capabilities, and issue a named client token. Tokens are shown once and only their hashes are stored. The same token, account scope, write/send/delete switches and send-idempotency ledger apply to MCP and AppleScript. macOS may separately ask the calling app for Automation permission. Aerio must be unlocked. Revoking the client or disabling external automation blocks subsequent requests.

```applescript
tell application "Aerio"
  call tool "{\"name\":\"list_accounts\",\"arguments\":{}}" authorization "aerio_mcp_REPLACE_WITH_ISSUED_TOKEN"
end tell
```

The reply is JSON: `{"ok":true,"result":...}` or `{"ok":false,"error":{"code":...,"message":...}}`. Tool names and argument shapes match [the MCP automation tools](mcp-automation.md). Keep tokens out of shared scripts and logs. Use the tool's idempotency key when sending; an Apple-event timeout does not prove a write/send failed, so inspect Aerio before retrying.

Commands accept up to 1 MiB of request JSON and return up to 2 MiB, with at most 16 native requests pending and a 60-second native timeout. The Cocoa handler suspends/resumes the Apple event while the main process awaits the mail worker. Authentication/lock/enablement are checked before the call and again before returning content, so locking or revoking during a read withholds the result. Existing service capability/account checks handle the operation itself. No arbitrary program evaluation entry point is exposed.

`native/macos/apple-script.mm` uses Node-API 8 and documented `NSAppleEventManager` APIs; `Aerio.sdef`, `NSAppleScriptEnabled`, and `OSAScriptingDefinition` supply bundle terminology. `npm run build:mac-native` uses the macOS SDK/Xcode command-line tools; normal builds invoke it automatically on macOS and skip it on other platforms. The binary is packaged outside the app archive in `Contents/Resources/native`. Windows and Linux do not load these APIs.

Validation available here: ten platform-independent tests for command/authentication/lock/revocation/capability boundaries, typecheck and packaging schema. The Windows development host has no Apple SDK or Apple-event runtime, so native compilation and live `osascript` execution cannot be claimed locally. The existing arm64/x64 macOS CI now explicitly compiles the addon and its packaged native audit runs dictionary discovery plus actual inbound `osascript` requests, disabled/invalid/revoked token checks, empty account scoping and lock checks. A denied macOS Automation permission fails that audit with an explicit explanation.

Primary references: [Apple scripting terminology](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AboutScriptingTerminology.html), [NSAppleScriptEnabled](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapplescriptenabled), [suspendCurrentAppleEvent](https://developer.apple.com/documentation/foundation/nsappleeventmanager/suspendcurrentappleevent()), [replyAppleEvent for suspension](https://developer.apple.com/documentation/foundation/nsappleeventmanager/replyappleevent(forsuspensionid:)), [resume suspended event](https://developer.apple.com/documentation/foundation/nsappleeventmanager/resume(withsuspensionid:)), [Node-API stability](https://nodejs.org/api/n-api.html).
