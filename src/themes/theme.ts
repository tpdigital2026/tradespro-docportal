import { readFileSync } from 'node:fs';
import path from 'node:path';

const HEX = /^#[0-9a-fA-F]{6}$/;
const NAME = /^[a-z][a-z0-9]*$/;

export function themeVarsCss(colours: Record<string, string>): string {
  const decls = Object.entries(colours).map(([name, value]) => {
    if (!NAME.test(name)) throw new Error(`Invalid theme variable name: ${name}`);
    if (!HEX.test(value)) throw new Error(`Invalid colour for ${name}: ${value}`);
    return `--${name}:${value};`;
  });
  return `:root{${decls.join('')}}`;
}

export function loadBaseCss(): string {
  return readFileSync(path.join(process.cwd(), 'src', 'themes', 'fjc', 'base.css'), 'utf8');
}
