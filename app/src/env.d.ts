// Los secretos no salen de wrangler.jsonc (no van al repositorio), asi que se
// declaran aqui y se cargan con `wrangler secret put`.
declare global {
  interface Env {
    ANTHROPIC_API_KEY: string;
    GEMINI_API_KEY: string;
    /** 'claude' (por defecto) o 'gemini'. Por instancia, en wrangler.jsonc. */
    MODELO_ANALISIS?: string;
  }
}

export {};
