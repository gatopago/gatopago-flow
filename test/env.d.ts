declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** Private part of SESSION_PUBLIC_JWK: the tests sign sessions as Wallet Core does. */
    TEST_SESSION_JWK: string;
  }
}
