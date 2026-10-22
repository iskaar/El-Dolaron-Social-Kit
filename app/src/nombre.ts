/** Entidades del proveedor/IA: una sola pasada, sin interpretar HTML. */
export function decodificarNombre(nombre: string): string {
  const entidades: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };
  return nombre.replace(/&(?:amp|quot|#39|lt|gt);/g, (entidad) => entidades[entidad]);
}
