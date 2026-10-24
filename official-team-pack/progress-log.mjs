import fs from 'node:fs';
import path from 'node:path';

const EVENT_FIELDS = {
  MATCH_LOGIN: ['status', 'requestId'],
  ENVIRONMENT_READY: ['status', 'requestId', 'repository', 'revision', 'build', 'matchLogin'],
  PREPARED: ['status'],
  BACKLOG_SYNC: ['status', 'backlogId', 'title'],
  BACKLOG_START_REQUESTED: ['status', 'backlogItemKey'],
  BACKLOG_IN_PROGRESS: ['status', 'backlogItemKey', 'revision'],
  SUBMIT_RECEIPT: ['status', 'backlogItemKey', 'receiptId', 'revision'],
};

function requiredString(event, key) {
  if (typeof event[key] !== 'string' || !event[key].trim()) throw new Error(`${event.event}.${key} must be a non-empty string`);
}

/** Validate only the public vocabulary from the briefing; BTC's final schema takes precedence. */
export function validateProgress(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('progress event must be an object');
  if (!Object.hasOwn(EVENT_FIELDS, event.event)) throw new Error(`unsupported progress event: ${event.event || '<missing>'}`);
  requiredString(event, 'event');
  for (const key of EVENT_FIELDS[event.event]) requiredString(event, key);
  if (event.at !== undefined && Number.isNaN(Date.parse(event.at))) throw new Error('event.at must be an ISO-8601 timestamp');
  return true;
}

export function appendProgress(file, event, now = new Date()) {
  const record = { ...event, at: event.at || now.toISOString() };
  validateProgress(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function readProgress(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
