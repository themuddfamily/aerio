import type { ExpoConfig, ConfigContext } from 'expo/config';
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
  const googleScheme = googleIosClientId.endsWith('.apps.googleusercontent.com') ? `com.googleusercontent.apps.${googleIosClientId.replace('.apps.googleusercontent.com', '')}` : 'com.googleusercontent.apps.aerio-unconfigured';
  return { ...config, name: 'Aerio', slug: 'aerio-mobile', plugins: (config.plugins ?? []).map((plugin) => Array.isArray(plugin) && plugin[0] === '@react-native-google-signin/google-signin' ? [plugin[0], { iosUrlScheme: googleScheme }] : plugin), extra: { googleIosClientId, googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '', microsoftClientId: process.env.EXPO_PUBLIC_MICROSOFT_CLIENT_ID ?? '', microsoftTenant: process.env.EXPO_PUBLIC_MICROSOFT_TENANT ?? 'common' } };
};
