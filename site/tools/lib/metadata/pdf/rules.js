// What the cleaner removes, shared with the inspector so that every block it marks removable is really
// gone after cleaning.
import { Dict, Stream, isName, nameOf } from './syntax.js';
import { filtersOf } from './filters.js';

// Keys dropped from every dictionary: metadata streams, application private data, thumbnails,
// additional (automatic) actions and associated files.
export const DROP_KEYS = new Set(['Metadata', 'PieceInfo', 'LastModified', 'Thumb', 'AA', 'AF']);

// Comment and markup annotations. Redaction marks stay: dropping one would hide that something was
// meant to be removed while the content under it is still in the file.
export const MARKUP = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'RichMedia', 'Projection']);

export const ACTIONS = new Set(['GoTo', 'GoToR', 'GoToE', 'GoToDp', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView', 'RichMediaExecute', 'ECMAScript']);
// Actions removed wherever they appear, including links and buttons a person clicks.
export const REMOVE_ACTIONS = new Set(['JavaScript', 'ECMAScript', 'Launch', 'ImportData', 'RichMediaExecute', 'GoToE', 'Rendition']);

export const actionType = (d) => (d instanceof Dict && (isName(d.get('Type'), 'Action') || ACTIONS.has(nameOf(d.get('S')))) ? nameOf(d.get('S')) ?? '' : null);

// True when the action or anything chained after it through /Next is removed.
export function chainRemovable(doc, v, depth = 0, seen = new Set()) {
  if (depth > 32) return true;
  if (Array.isArray(v)) return v.some((x) => chainRemovable(doc, x, depth + 1, seen));
  if (v?.num !== undefined) { if (seen.has(v.num)) return false; seen.add(v.num); }
  const d = doc.resolve(v);
  if (Array.isArray(d)) return d.some((x) => chainRemovable(doc, x, depth + 1, seen));
  const type = actionType(d);
  if (type === null) return false;
  return REMOVE_ACTIONS.has(type) || (d.has('Next') && chainRemovable(doc, d.get('Next'), depth + 1, seen));
}

// /OpenAction stays only when it is a destination or a plain go-to.
export function openActionKept(doc, v) {
  const d = doc.resolve(v);
  if (Array.isArray(d)) return true;
  return actionType(d) === 'GoTo' && !(d.has('Next') && chainRemovable(doc, d.get('Next')));
}

export const removedAnnotation = (d) => d instanceof Dict && MARKUP.has(nameOf(d.get('Subtype')));
// Authorship and comment text dropped from the redaction marks that stay.
export const REDACT_DROP = new Set(['T', 'Contents', 'RC', 'M', 'CreationDate', 'Subj', 'NM', 'Popup', 'IRT']);

// JPEG image streams the cleaner can rewrite: the JPEG is stored as is, with no other filter.
export function cleanableJpeg(doc, s) {
  if (!(s instanceof Stream)) return false;
  const f = filtersOf(s.dict, (v) => doc.resolve(v));
  return f.length === 1 && f[0].name === 'DCTDecode';
}

// The field type, inherited through /Parent.
export function fieldType(doc, d) {
  for (let i = 0; d instanceof Dict && i < 32; i++, d = doc.resolve(d.get('Parent'))) if (d.has('FT')) return nameOf(doc.resolve(d.get('FT')));
  return null;
}

export function filledValue(doc, v) {
  v = doc.resolve(v);
  if (v === null || v === undefined) return false;
  if (isName(v)) return v.name !== 'Off' && v.name !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (v?.bytes) return v.bytes.length > 0 && !(v.bytes.length === 2 && v.bytes[0] === 0xfe && v.bytes[1] === 0xff);
  return !(v instanceof Dict || v instanceof Stream);
}
