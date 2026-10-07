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
    /** 'si' = buscar el precio en la web en vez de estimarlo de memoria. */
    BUSQUEDA_WEB?: string;
    /** Hostname que solo sirve la camara. Vacio = una sola puerta, como antes. */
    HOST_VENDEDOR?: string;
    /** 'sandbox' en wrangler.sandbox.jsonc: pinta la franja en todas las pantallas. */
    AMBIENTE?: string;
    /** Solo `wrangler dev` con `--var ACCESS_EQUIPO:local`: el correo con el que se entra. */
    DEV_USUARIO?: string;
    /** Host público exacto. Ausente = portal inaccesible. */
    HOST_PORTAL?: string;
    FIREBASE_PROJECT_ID?: string;
    FIREBASE_WEB_API_KEY?: string;
    FIREBASE_AUTH_DOMAIN?: string;
    /** Textos finales aprobados; se muestran antes de la aceptación o del SMS. */
    PORTAL_BASES_TEXTO?: string;
    PORTAL_AVISO_TEXTO?: string;
    /** Requiere texto legal aprobado y despliegue coordinado. */
    BASES_APROBADAS_VERSION?: string;
    PORTAL_REGISTRO_ABIERTO?: string;
    PROMOCION_INICIO?: string;
    /** Emisión de vales anónimos: ausente = apagada, requiere bases finales. */
    VALES_ABIERTOS?: string;
    /** Promo de inauguracion (ISO, UTC): ambas o ninguna. Quitarlas y desplegar la apaga. */
    PROMO_DESDE?: string;
    PROMO_HASTA?: string;
    /** Mercado Libre (Issue #170). Secretos con `wrangler secret put`; ML_REDIRECT_URI es var. */
    ML_CLIENT_ID?: string;
    ML_CLIENT_SECRET?: string;
    /** base64 de 32 bytes: cifra los tokens de ML en D1 (AES-GCM). */
    ML_LLAVE_TOKENS?: string;
    /** Segmento secreto de la URL de notificaciones: /api/ml/notificaciones/<esto>. */
    ML_RUTA_NOTIFICACIONES?: string;
    /** Debe ser identica a la registrada en la app de ML. */
    ML_REDIRECT_URI?: string;
    /** 'no' = no usar PKCE (solo si la app de ML se creo sin esa casilla). */
    ML_PKCE?: string;
  }
}

export {};
