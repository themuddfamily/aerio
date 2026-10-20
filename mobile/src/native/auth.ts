import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { fetch as nativeFetch } from 'expo/fetch';
import type { Account, ClientSettings, MicrosoftCredential } from '../core/types';
import { microsoftAuthority } from '../core/sessions';
import { providerClient } from '../core/providers';
WebBrowser.maybeCompleteAuthSession();
const googleScopes = ['https://www.googleapis.com/auth/gmail.modify'];
export const microsoftRedirect = 'aerio://oauth/microsoft';
function configureGoogle(settings: ClientSettings) {
  if (Platform.OS === 'ios' && !settings.googleIosClientId) throw new Error('This build needs an iOS Google OAuth client ID. See mobile/README.md.');
  if (Platform.OS === 'android' && !settings.googleWebClientId) throw new Error('Configure your Google web client ID in Accounts settings and register the Android package and signing SHA-1.');
  GoogleSignin.configure({ scopes: googleScopes, offlineAccess: false, ...(settings.googleIosClientId ? { iosClientId: settings.googleIosClientId } : {}), ...(settings.googleWebClientId ? { webClientId: settings.googleWebClientId } : {}) });
}
export async function connectGoogle(settings: ClientSettings): Promise<Account> {
  configureGoogle(settings);
  if (Platform.OS === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const response = await GoogleSignin.signIn();
  if (response.type !== 'success') throw new Error('Google sign-in cancelled.');
  const granted = await GoogleSignin.addScopes({ scopes: googleScopes });
  if (granted?.type === 'cancelled') throw new Error('Gmail permission was not granted.');
  const { accessToken } = await GoogleSignin.getTokens();
  const profile = await providerClient('google', nativeFetch).profile(accessToken);
  if (profile.email.toLowerCase() !== response.data.user.email.toLowerCase()) throw new Error('Google returned a different mailbox. Sign in again.');
  return { id: `google:${profile.subject}`, provider: 'google', ...profile, name: response.data.user.name || profile.name };
}
export async function googleToken(account: Account, settings: ClientSettings) {
  configureGoogle(settings);
  let current = GoogleSignin.getCurrentUser();
  if (!current) { const response = await GoogleSignin.signInSilently(); if (response.type === 'success') current = response.data; }
  if (!current || current.user.email.toLowerCase() !== account.email.toLowerCase()) throw new Error(`Reconnect ${account.email} in Accounts. The native Google session belongs to another mailbox.`);
  const token = (await GoogleSignin.getTokens()).accessToken;
  // Native Google Sign-In is a singleton. Another sign-in may finish while getTokens awaits.
  const owner = await providerClient('google', nativeFetch).profile(token);
  if (owner.subject !== account.subject || owner.email.toLowerCase() !== account.email.toLowerCase()) throw new Error('The Google session changed accounts. Reconnect the requested mailbox.');
  return token;
}
export async function connectMicrosoft(settings: ClientSettings): Promise<{ account: Account; credential: MicrosoftCredential }> {
  if (!/^[a-f0-9-]{36}$/i.test(settings.microsoftClientId)) throw new Error('Enter your Microsoft public-client application ID in Accounts settings.');
  const authority = microsoftAuthority(settings.microsoftTenant), discovery = { authorizationEndpoint: `${authority}/authorize`, tokenEndpoint: `${authority}/token` };
  const request = new AuthSession.AuthRequest({ clientId: settings.microsoftClientId, redirectUri: microsoftRedirect, responseType: AuthSession.ResponseType.Code, usePKCE: true, codeChallengeMethod: AuthSession.CodeChallengeMethod.S256, scopes: ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'], extraParams: { prompt: 'select_account' } });
  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success' || !result.params.code || !request.codeVerifier) throw new Error('Microsoft sign-in cancelled or did not return an authorization code.');
  const token = await AuthSession.exchangeCodeAsync({ clientId: settings.microsoftClientId, code: result.params.code, redirectUri: microsoftRedirect, extraParams: { code_verifier: request.codeVerifier } }, discovery);
  const profile = await providerClient('microsoft', nativeFetch).profile(token.accessToken);
  return { account: { id: `microsoft:${profile.subject}`, provider: 'microsoft', ...profile }, credential: { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000, clientId: settings.microsoftClientId, tenant: settings.microsoftTenant } };
}
export async function signOutGoogle(account: Account) { if (GoogleSignin.getCurrentUser()?.user.email.toLowerCase() === account.email.toLowerCase()) await GoogleSignin.signOut(); }
