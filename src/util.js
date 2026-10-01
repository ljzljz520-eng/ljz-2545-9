'use strict';
/** 通用工具：ID 生成、本地时间格式化（全站统一 YYYY-MM-DDTHH:MM:SS 朴素本地时间，字典序即可比较） */
const crypto = require('node:crypto');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function nowStr() { return fmtLocal(new Date()); }
function addSeconds(iso, sec) { return fmtLocal(new Date(new Date(iso).getTime() + sec * 1000)); }
function addHours(iso, h) { return addSeconds(iso, h * 3600); }

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; }

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
const badRequest = (msg, details) => new ApiError(400, 'BAD_REQUEST', msg, details);
const notFound = (msg, details) => new ApiError(404, 'NOT_FOUND', msg, details);
const conflict = (code, msg, details) => new ApiError(409, code, msg, details);

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') throw badRequest(`缺少字段: ${f}`);
  }
}
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
function requireTime(v, name) {
  if (!TIME_RE.test(v || '')) throw badRequest(`${name} 须为 YYYY-MM-DDTHH:MM 格式`);
  return v.length === 16 ? v + ':00' : v;
}

module.exports = { fmtLocal, nowStr, addSeconds, addHours, uid, ApiError, badRequest, notFound, conflict, requireFields, requireTime };
