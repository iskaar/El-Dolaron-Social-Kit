// Los secretos no salen de wrangler.jsonc (no van al repositorio), asi que se
// declaran aqui y se cargan con `wrangler secret put`.
declare global {
  interface Env {
    ANTHROPIC_API_KEY: string;
    GEMINI_API_KEY: string;
    /** Alterno: alguna instancia guarda la llave con este nombre. */
    GEMINI2_API_KEY?: string;
    /** 'claude' (por defecto) o 'gemini'. Por instancia, en wrangler.jsonc. */
    MODELO_ANALISIS?: string;
    /** Hostname que solo sirve la camara. Vacio = una sola puerta, como antes. */
    HOST_VENDEDOR?: string;
  }
}

export {};
