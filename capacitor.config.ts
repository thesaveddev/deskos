import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.deskos.app',
  appName: 'ReyDesk',
  webDir: 'apps/web/dist',
  server: {
    androidScheme: 'https',
    // For development, point to your local dev server:
    // url: 'http://YOUR_IP:5180',
    // cleartext: true,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#e8a33d',
    },
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  ios: {
    contentInset: 'automatic',
    scheme: 'ReyDesk',
  },
}

export default config
