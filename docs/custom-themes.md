# Custom themes

In Settings → Appearance, choose **Create theme** to name and edit a palette. Each palette stores the workspace, surface, text, border, accent, danger and success colors. The light/dark base controls native widgets, shadows and existing appearance-specific styling. **Reset colors to base** restores the built-in palette. A preview shows the draft; **Save and apply theme** persists it and activates it across the workspace. Built-in system/light/dark buttons clear the custom selection, while preserving saved palettes. Deleting the active theme restores the chosen built-in appearance.

Use **Export** beside a saved palette to download an `.aerio-theme.json` file. **Import theme** opens a palette for review and editing; save it to apply it. Imports receive a fresh ID so they cannot overwrite an existing palette. Names and IDs are validated, colors accept only six-digit hex values, and arbitrary CSS, URLs and scripts are never applied. The versioned JSON format is Aerio-specific; eM Client XML themes are not compatible.

Up to 50 themes can be saved. Imports are limited to 64 KB. Themes and the active selection persist in application preferences, including profile backups; detached message windows apply the selection when opened. Editing palette colors does not alter message HTML or sender-provided styling. User-chosen color contrast is visible in the preview and should be checked before applying.

Verification: `npx vitest run src/lib/themes.test.ts src/components/ThemeEditor.test.tsx src/App.test.tsx src/views/MessageWindow.test.tsx`.
