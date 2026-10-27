// Minimal JSON-Schema validator for the keywords used by contracts/*.schema.json
// (oneOf, $ref, type, const, enum, required, properties, additionalProperties:false,
// minLength/maxLength/pattern, minimum/maximum, minItems/maxItems, uniqueItems, prefixItems, boolean items, if/then/else). Validation is driven by the
// contract file itself, so the pack and the organizer schema cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, '..', 'contracts');

function typeOk(type, v) {
  switch (type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((n, k) => n?.[k], root);
}

export function validate(schema, value, root = schema, at = '$') {
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  const errs = [];
  if (schema.if) {
    const branch = validate(schema.if, value, root, at).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errs.push(...validate(branch, value, root, at));
  }
  if (schema.$ref) return validate(resolveRef(root, schema.$ref), value, root, at);
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validate(s, value, root, at));
    const ok = results.filter((r) => r.length === 0).length;
    if (ok === 1) return [];
    if (ok > 1) return [`${at}: matches more than one schema`];
    // Report the branch that shares the event type, when there is one: clearer errors.
    const byType = schema.oneOf.findIndex((s) => s.properties?.type?.const !== undefined && s.properties.type.const === value?.type);
    if (byType >= 0) return results[byType];
    const nonNull = schema.oneOf.findIndex((s) => !(s.type === 'null'));
    return results[nonNull >= 0 ? nonNull : 0].length ? results[nonNull >= 0 ? nonNull : 0] : [`${at}: no schema matched`];
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: must be one of ${schema.enum.join('|')}`);
  if (schema.type && !typeOk(schema.type, value)) {
    errs.push(`${at}: must be ${schema.type}`);
    return errs;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((v, i) => value.slice(0, i).some((other) => isDeepStrictEqual(v, other)))) errs.push(`${at}: items must be unique`);
    value.forEach((v, i) => {
      const itemSchema = i < (schema.prefixItems?.length || 0) ? schema.prefixItems[i] : schema.items;
      if (itemSchema !== undefined) errs.push(...validate(itemSchema, v, root, `${at}[${i}]`));
    });
  }
  if (typeOk('object', value) && (schema.properties || schema.required || schema.additionalProperties === false)) {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
    }
  }
  return errs;
}

let progressSchema;
let finalSchema;

export function progressEventSchema() {
  progressSchema ||= JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'progress-event.schema.json'), 'utf8'));
  return progressSchema;
}

export function finalResultSchema() {
  finalSchema ||= JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'final-result.schema.json'), 'utf8'));
  return finalSchema;
}

/** Errors for one progress event (empty array = valid). */
export function validateProgressEvent(event) {
  return validate(progressEventSchema(), event);
}

export function validateFinalResult(result) {
  return validate(finalResultSchema(), result);
}

export const EVENT_TYPES = () => progressEventSchema().oneOf.map((s) => s.properties.type.const);
