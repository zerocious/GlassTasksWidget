'use strict';

/**
 * Storage incidents the user should see (restored backup, reset file, secrets kept in memory…).
 * Kept in memory for this session; electron/data-ipc.js forwards new ones to the widget and
 * lib/storage-status.js includes them in the diagnostics report.
 *
 * @typedef {'info' | 'warning' | 'error'} IssueLevel
 * @typedef {{ at: string, kind: string, file: string | null, level: IssueLevel, message: string }} StorageIssue
 */

const MAX_ISSUES = 50;

/** @type {StorageIssue[]} */
const issues = [];
/** @type {Set<string>} kind + file pairs already reported (one-shot issues) */
const seen = new Set();
/** @type {Set<(issue: StorageIssue) => void>} */
const listeners = new Set();

/**
 * @param {{ kind: string, file?: string | null, level?: IssueLevel, message: string, detail?: string, repeat?: boolean }} input
 *   repeat: report again even if the same kind + file was already reported this session.
 * @returns {StorageIssue | null} null when suppressed as a duplicate
 */
function reportStorageIssue(input) {
  const file = input.file || null;
  const key = `${input.kind}|${file || ''}`;
  if (!input.repeat && seen.has(key)) return null;
  seen.add(key);
  /** @type {StorageIssue} */
  const issue = {
    at: new Date().toISOString(),
    kind: input.kind,
    file,
    level: input.level || 'warning',
    message: input.message,
  };
  issues.push(issue);
  if (issues.length > MAX_ISSUES) issues.splice(0, issues.length - MAX_ISSUES);
  const log = issue.level === 'info' ? console.info : console.warn;
  log(`[storage] ${issue.kind}${file ? ` ${file}` : ''}: ${input.detail || issue.message}`);
  for (const fn of listeners) {
    try {
      fn(issue);
    } catch {
      /* a broken listener must not break storage */
    }
  }
  return issue;
}

/** @returns {StorageIssue[]} oldest first */
function getStorageIssues() {
  return issues.slice();
}

/** @param {(issue: StorageIssue) => void} fn @returns {() => void} unsubscribe */
function onStorageIssue(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function clearStorageIssues() {
  issues.length = 0;
  seen.clear();
}

module.exports = {
  reportStorageIssue,
  getStorageIssues,
  onStorageIssue,
  clearStorageIssues,
};
