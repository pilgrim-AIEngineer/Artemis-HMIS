import type messages from './messages/en.json';

// Type-safe message keys for next-intl; hi.json must have the same shape (checked in tests).
declare module 'next-intl' {
  interface AppConfig {
    Messages: typeof messages;
  }
}
