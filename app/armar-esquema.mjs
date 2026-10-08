// Base nueva completa: schema.sql y luego cada migracion-*.sql, en el orden de src/prueba-d1.ts.
// Escribe .wrangler/esquema-completo.sql. Solo para una base VACIA: las migraciones hacen ALTER.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const archivos = ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort()];
mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/esquema-completo.sql', archivos.map((f) => `-- ${f}\n${readFileSync(f, 'utf8')}`).join('\n'));
console.log(`${archivos.length} archivos -> .wrangler/esquema-completo.sql`);
