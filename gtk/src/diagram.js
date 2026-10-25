// Mermaid fences drawn with pele, as the web does: pele lays the diagram out
// as SVG and librsvg rasterises it.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import { AspectPicture, showPictureDialog } from './picture.js';

// Sharp on HiDPI.
const RASTER_SCALE = 2;

let pele = null;
let loading = null;
let missed = false;
const readyCallbacks = [];
const cache = new Map();

// A fence still being streamed stays a code block.
export function isClosedFence(raw) {
  return /\n {0,3}(?:`{3,}|~{3,})[ \t]*\n*$/.test(String(raw || ''));
}

// pele is 600 kB, so it loads on first use.
export function preload() {
  loading ??= (installMeasure(), import('./vendor/pele.js')).then(module => {
    pele = module;
    if (missed) for (const callback of readyCallbacks) callback();
    missed = false;
  }, error => {
    console.warn(`mermaid diagrams unavailable: ${error.message}`);
  });
  return loading;
}

// callback runs once pele has loaded, if a diagram was asked for before then.
export function onReady(callback) {
  readyCallbacks.push(callback);
}

// Drawn diagrams have the theme's colours baked in.
export function anyDrawn() {
  return cache.size > 0;
}

// A widget showing the diagram, or null to leave the source as a code block:
// pele not loaded yet, or the source is not one it can draw.
export function diagramWidget(source) {
  if (!pele) {
    missed = true;
    preload();
    return null;
  }
  const dark = Adw.StyleManager.get_default().get_dark();
  const key = `${dark ? 'd' : 'l'}\n${source}`;
  let entry = cache.get(key);
  if (entry === undefined) {
    entry = renderTexture(source, dark);
    if (cache.size >= 100) cache.clear();
    cache.set(key, entry);
  }
  if (!entry) return null;
  const picture = new AspectPicture({
    paintable: entry.texture,
    can_shrink: true,
    content_fit: Gtk.ContentFit.CONTAIN,
    halign: Gtk.Align.START,
    tooltip_text: 'Click to enlarge',
  });
  picture.setAspect(entry.width, entry.height);
  picture.set_cursor(Gdk.Cursor.new_from_name('pointer', null));
  const click = new Gtk.GestureClick();
  click.connect('released', gesture => showPictureDialog(
    gesture.get_widget().get_root(), entry.texture, 'Diagram'));
  picture.add_controller(click);
  // Never wider than drawn; a size request would overflow narrow windows.
  const clamp = new Adw.Clamp({ child: picture, maximum_size: Math.ceil(entry.width) });
  clamp.add_css_class('diagram');
  return clamp;
}

function renderTexture(source, dark) {
  try {
    const family = uiFontFamily();
    const { svg } = pele.render(source, {
      idPrefix: 'd-',
      fontFamily: family,
      fontSize: 14,
      links: false,
      images: false,
    });
    const resolved = resolveColors(svg, palette(dark), family);
    const size = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(resolved);
    const width = Number(size?.[1]) || 0;
    const height = Number(size?.[2]) || 0;
    if (!width || !height) return null;
    const scaled = resolved.replace(/^<svg([^>]*?) width="[\d.]+" height="[\d.]+"/,
      `<svg$1 width="${width * RASTER_SCALE}" height="${height * RASTER_SCALE}"`);
    const texture = Gdk.Texture.new_from_bytes(
      new GLib.Bytes(new TextEncoder().encode(scaled)));
    return { texture, width, height };
  } catch (_) {
    // Not something pele can draw (or librsvg can read): keep the source.
    return null;
  }
}

// The family GTK draws text in, so measurement and drawing agree.
function uiFontFamily() {
  const name = Gtk.Settings.get_default()?.gtk_font_name || 'Sans 11';
  return Pango.FontDescription.from_string(name).get_family() || 'Sans';
}

// The web's mapping of pele's roles, in Adwaita's colours.
function palette(dark) {
  const accent = Adw.StyleManager.get_default().get_accent_color_rgba().to_string();
  return dark
    ? {
        'pele-bg': '#222226', 'pele-fg': '#ffffff', 'pele-muted': '#a6a6a9',
        'pele-line': '#a6a6a9', 'pele-surface': '#2e2e32', 'pele-surface-alt': '#38383c',
        'pele-border': '#77777b', 'pele-accent': accent,
        'pele-critical': '#ff7b63', 'pele-error': '#ff7b63',
      }
    : {
        'pele-bg': '#ffffff', 'pele-fg': '#2e2e33', 'pele-muted': '#6e6e73',
        'pele-line': '#6e6e73', 'pele-surface': '#f4f4f5', 'pele-surface-alt': '#ebebed',
        'pele-border': '#9a9a9f', 'pele-accent': accent,
        'pele-critical': '#c01c28', 'pele-error': '#c01c28',
      };
}

const VAR = /var\(--([\w-]+)(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

// librsvg reads neither CSS variables nor color-mix(): resolve them to plain
// values, from the theme, then the root's declarations, then var() fallbacks.
export function resolveColors(svg, overrides, family = 'sans-serif') {
  const declared = new Map();
  const rootStyle = /^<svg[^>]*\sstyle="([^"]*)"/.exec(svg)?.[1] || '';
  for (const [, name, value] of rootStyle.matchAll(/--([\w-]+):((?:[^;()]|\([^()]*(?:\([^()]*\))*[^()]*\))*)/g)) {
    declared.set(name, value.trim());
  }
  const values = { ...overrides, 'pele-font': family };
  const resolve = (text, depth = 0) => {
    if (depth > 8) return text;
    return text.replace(VAR, (_all, name, fallback) => {
      if (values[name] !== undefined) return values[name];
      if (declared.has(name)) return resolve(declared.get(name), depth + 1);
      return fallback !== undefined ? resolve(fallback.trim(), depth + 1) : '';
    });
  };
  let out = resolve(svg);
  out = out.replace(/color-mix\(in srgb,\s*([^,()]+|rgba?\([^()]*\))\s+([\d.]+)%,\s*([^,()]+|rgba?\([^()]*\))\)/g,
    (all, a, percent, b) => mix(a.trim(), b.trim(), Number(percent) / 100) || all);
  // A border radius given as a style property, which librsvg ignores.
  out = out.replace(/style="rx:([\d.]+)px"/g, 'rx="$1"');
  return out;
}

function mix(a, b, weight) {
  const ca = new Gdk.RGBA();
  const cb = new Gdk.RGBA();
  if (!ca.parse(a) || !cb.parse(b)) return '';
  const channel = (x, y) => Math.round((x * weight + y * (1 - weight)) * 255);
  return `rgb(${channel(ca.red, cb.red)},${channel(ca.green, cb.green)},${channel(ca.blue, cb.blue)})`;
}

// pele measures text with a canvas when it finds one; this one measures with
// Pango, so widths match what GTK draws. Fonts come as
// "[italic ][bold ]<size>px <family>".
function installMeasure() {
  if (globalThis.OffscreenCanvas) return;
  let layout = null;
  globalThis.OffscreenCanvas = class {
    getContext() {
      layout ??= Pango.Layout.new(PangoCairo.FontMap.get_default().create_context());
      return {
        font: '',
        measureText(text) {
          const match = /^(italic )?(bold )?([\d.]+)px (.+)$/.exec(this.font);
          const description = new Pango.FontDescription();
          description.set_family(match?.[4] || 'sans-serif');
          description.set_absolute_size((Number(match?.[3]) || 14) * Pango.SCALE);
          if (match?.[1]) description.set_style(Pango.Style.ITALIC);
          if (match?.[2]) description.set_weight(Pango.Weight.BOLD);
          layout.set_font_description(description);
          layout.set_text(String(text), -1);
          const [, logical] = layout.get_extents();
          return { width: logical.width / Pango.SCALE };
        },
      };
    }
  };
}
