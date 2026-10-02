import { openDatabase, readAll, putRecord, putEntryAndProject, removeRecord, mergeMissing, removeProjectForever } from "./db.js";

const $ = selector => document.querySelector(selector);
const DAY = 24 * 60 * 60 * 1000;
const MAX_REMINDER_DAYS = 36500;
let db;
let projects = [];
let entries = [];
let meta = [];
let toneMap = new Map();
let draft = null;
let draftTimer = null;
let draftWrite = Promise.resolve();
let noticeTimer = null;
const DRAFT_KEY = "xuji-temporary-draft";

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
}

function button(text, action, id, className = "chip-button") {
  const item = node("button", className, text);
  item.type = "button";
  item.dataset.action = action;
  if (id) item.dataset.id = id;
  return item;
}

function notice(message, error = false) {
  const box = $("#status-message");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { box.hidden = true; }, error ? 9000 : 5000);
}

function show(dialogId) {
  const dialog = $("#" + dialogId);
  if (!dialog.open) dialog.showModal();
}

function close(dialogId) {
  const dialog = $("#" + dialogId);
  if (dialog.open) dialog.close();
}

function today() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function dayOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return today();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function niceDate(day) {
  const parts = String(day).split("-");
  return parts.length === 3 ? Number(parts[1]) + "月" + Number(parts[2]) + "日" : day;
}

function dayCount(day) {
  const parts = String(day).split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  const stamp = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const now = new Date();
  const localToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((localToday - stamp) / DAY));
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function activeProjects() {
  return projects.filter(project => !project.deletedAt && project.status === "active");
}

function visibleEntries(projectId) {
  return entries.filter(entry => !entry.deletedAt && entry.projectId === projectId)
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt));
}

function latestEntry(projectId) {
  return entries.filter(entry => !entry.deletedAt && entry.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

function activityDay(project) {
  const latest = latestEntry(project.id);
  return dayOf(latest ? latest.createdAt : project.createdAt);
}

function isStale(project) {
  return project.reminderDays > 0 && dayCount(activityDay(project)) >= project.reminderDays;
}

function projectName(id) {
  const project = projects.find(item => item.id === id);
  if (!id) return "未分类";
  if (!project) return "未分类";
  return project.deletedAt ? project.title + "（在回收站）" : project.title;
}

function statusText(status) {
  return { active: "进行中", paused: "已暂停", completed: "已完成", archived: "已归档" }[status] || status;
}

function toneFor(id) {
  if (toneMap.has(id)) return toneMap.get(id);
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return String(Math.abs(hash) % 5);
}

function validReminderDays(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_DAYS;
}

function reminderFromFields(daysInput, offInput) {
  if (offInput.checked) return 0;
  const raw = daysInput.value.trim();
  const days = Number(raw);
  if (!raw || !Number.isInteger(days) || days < 1 || days > MAX_REMINDER_DAYS) {
    notice("提醒天数请填 1 到 36500 之间的整数，或选择不提醒。", true);
    daysInput.focus();
    return null;
  }
  return days;
}

function syncReminderFields(daysInput, offInput) {
  daysInput.disabled = offInput.checked;
  daysInput.required = !offInput.checked;
}

function renderProjectCard(project, stale = false) {
  const card = node("article", "thing-card" + (stale ? " stale" : ""));
  card.dataset.tone = toneFor(project.id);
  const top = node("div", "thing-top");
  top.append(node("h3", "thing-title", project.title));
  const count = dayCount(activityDay(project));
  const date = node("p", "thing-date", latestEntry(project.id)
    ? "上次记录：" + niceDate(activityDay(project)) + " · " + (count === 0 ? "今天" : count + "天前")
    : "还没有记录");
  top.append(date);
  card.append(top);
  const latest = latestEntry(project.id);
  if (latest) card.append(node("p", "thing-note", latest.content));
  if (project.returnPoint) card.append(node("p", "thing-return", "下次从这接：" + project.returnPoint));
  const actions = node("div", "thing-actions");
  if (project.status === "active") actions.append(button("记一下", "capture-project", project.id, "chip-button emphasis"));
  actions.append(button("查看", "project-detail", project.id));
  if (stale) actions.append(button("先暂停", "pause-project", project.id));
  card.append(actions);
  return card;
}

function renderRecordCard(entry) {
  const card = node("article", "record-card");
  if (entry.projectId) card.dataset.tone = toneFor(entry.projectId);
  const metaLine = node("div", "record-meta");
  metaLine.append(node("span", "", projectName(entry.projectId)));
  metaLine.append(node("time", "", niceDate(entry.occurredOn)));
  card.append(metaLine, node("p", "record-preview", entry.content), button("查看原话", "entry-detail", entry.id, "record-open"));
  return card;
}

function renderSearch() {
  const box = $("#search-results");
  box.replaceChildren();
  const query = $("#search-input").value.trim().toLocaleLowerCase();
  const matchingProjects = query ? projects.filter(project => !project.deletedAt &&
    project.title.toLocaleLowerCase().includes(query)).slice(0, 20) : [];
  const matches = entries.filter(entry => !entry.deletedAt && (!query ||
    entry.content.toLocaleLowerCase().includes(query) ||
    projectName(entry.projectId).toLocaleLowerCase().includes(query)))
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt));
  const subset = query ? matches.slice(0, 60) : matches.slice(0, 6);
  if (!subset.length && !matchingProjects.length) {
    box.append(node("p", "empty-inline", query ? "没有找到匹配的事情或原话。" : "还没有记录。可以直接粘贴一段原话。"));
    return;
  }
  for (const project of matchingProjects) {
    const card = node("article", "record-card project-search-result");
    card.dataset.tone = toneFor(project.id);
    card.append(node("h3", "", project.title), node("p", "microcopy", statusText(project.status) + " · " +
      (latestEntry(project.id) ? "上次记录 " + niceDate(activityDay(project)) : "还没有记录")),
      button("打开事情", "project-detail", project.id, "record-open"));
    box.append(card);
  }
  for (const entry of subset) box.append(renderRecordCard(entry));
  if (matches.length > subset.length) {
    box.append(node("p", "microcopy", query ? "显示前 60 条匹配记录，请缩小搜索范围。" : "显示最近 6 条。输入关键词可以找更早的记录。"));
  }
}

function render() {
  toneMap = new Map([...projects]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((project, index) => [project.id, String(index % 5)]));
  const active = activeProjects().sort((a, b) => activityDay(b).localeCompare(activityDay(a)) || b.createdAt.localeCompare(a.createdAt));
  const visibleProjectCount = projects.filter(project => !project.deletedAt).length;
  const projectQuery = $("#project-filter").value.trim().toLocaleLowerCase();
  const matchesProject = project => !projectQuery || project.title.toLocaleLowerCase().includes(projectQuery);
  const stale = active.filter(project => isStale(project) && matchesProject(project));
  const current = active.filter(project => !isStale(project) && matchesProject(project));
  const others = projects.filter(project => !project.deletedAt && project.status !== "active" && matchesProject(project));
  $("#active-count").textContent = String(active.length);
  $("#active-empty").hidden = active.length > 0 || !!projectQuery;
  $("#project-filter-wrap").hidden = visibleProjectCount < 8 && !projectQuery;
  $("#project-filter-empty").hidden = !projectQuery || stale.length + current.length + others.length > 0;
  $("#stale-section").hidden = stale.length === 0;
  $("#other-section").hidden = others.length === 0;
  $("#stale-list").replaceChildren(...stale.map(project => renderProjectCard(project, true)));
  $("#active-list").replaceChildren(...current.map(project => renderProjectCard(project)));
  $("#other-list").replaceChildren(...others.map(project => renderProjectCard(project)));
  renderSearch();
  const backupMeta = meta.find(item => item.key === "lastExport");
  $("#last-backup").textContent = backupMeta && backupMeta.value
    ? "上次生成备份：" + niceDate(dayOf(backupMeta.value)) + "。请确认文件已经保存在“文件”里。"
    : "还没有生成过备份。";
}

function populateProjectSelect(select, selectedId = "") {
  select.replaceChildren();
  const blank = node("option", "", "不分类");
  blank.value = "";
  select.append(blank);
  for (const project of projects.filter(item => !item.deletedAt)) {
    const option = node("option", "", project.title + (project.status === "active" ? "" : "（" + statusText(project.status) + "）"));
    option.value = project.id;
    select.append(option);
  }
  select.value = selectedId || "";
}

function captureDraft() {
  return {
    content: $("#entry-content").value,
    projectId: $("#entry-project").value || null,
    occurredOn: $("#entry-date").value,
    returnPoint: $("#entry-return").value
  };
}

function cacheDraftLocally(value) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)); } catch (error) { /* IndexedDB remains the draft store. */ }
}

function cachedDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (error) { return null; }
}

function scheduleDraft() {
  draft = { ...captureDraft(), savedAt: new Date().toISOString() };
  cacheDraftLocally(draft);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftWrite = putRecord(db, "meta", { key: "captureDraft", value: draft })
      .catch(() => notice("草稿暂时没能保存到这台设备，请先别关闭页面。", true));
  }, 120);
}

async function flushDraft() {
  if (draftTimer !== null) {
    clearTimeout(draftTimer);
    draftTimer = null;
    draft = { ...captureDraft(), savedAt: new Date().toISOString() };
    cacheDraftLocally(draft);
    draftWrite = putRecord(db, "meta", { key: "captureDraft", value: draft });
  }
  await draftWrite;
}

function openCapture(projectId = null) {
  populateProjectSelect($("#entry-project"), draft && draft.content ? draft.projectId : projectId);
  $("#entry-content").value = draft && draft.content ? draft.content : "";
  $("#entry-date").value = draft && draft.content && draft.occurredOn ? draft.occurredOn : today();
  $("#entry-date").max = today();
  $("#entry-return").value = draft && draft.content ? draft.returnPoint || "" : "";
  show("capture-dialog");
  $("#entry-content").focus();
}

async function saveEntry(event) {
  event.preventDefault();
  const content = $("#entry-content").value;
  if (!content.trim()) {
    notice("先粘贴或输入一点内容。", true);
    $("#entry-content").focus();
    return;
  }
  const projectId = $("#entry-project").value || null;
  if (!validDay($("#entry-date").value) || $("#entry-date").value > today()) {
    notice("发生日期不能晚于今天。", true);
    return;
  }
  const project = projects.find(item => item.id === projectId && !item.deletedAt) || null;
  const returnPoint = $("#entry-return").value.trim();
  const now = new Date().toISOString();
  const entry = { id: makeId(), projectId: project ? project.id : null, content, occurredOn: $("#entry-date").value, returnPoint, createdAt: now, updatedAt: now, deletedAt: null };
  const changedProject = project && returnPoint ? { ...project, returnPoint, updatedAt: now } : null;
  const saveButton = $("#entry-save");
  saveButton.disabled = true;
  try {
    clearTimeout(draftTimer);
    draftTimer = null;
    await draftWrite.catch(() => {});
    await putEntryAndProject(db, entry, changedProject);
    entries.push(entry);
    if (changedProject) projects = projects.map(item => item.id === project.id ? changedProject : item);
    draft = null;
    try { localStorage.removeItem(DRAFT_KEY); } catch (error) { /* IndexedDB cleanup follows. */ }
    $("#capture-form").reset();
    close("capture-dialog");
    render();
    notice("已保存原话。");
    putRecord(db, "meta", { key: "captureDraft", value: null }).catch(() => {
      notice("原话已保存，但草稿没能清除。下次打开时可以手动清空。", true);
    });
  } catch (error) {
    notice("没保存成功，文字还留在输入框里。请重试或先复制出来。", true);
  } finally {
    saveButton.disabled = false;
  }
}

async function saveProject(event) {
  event.preventDefault();
  const title = $("#project-title").value.trim();
  if (!title) return;
  const reminderDays = reminderFromFields($("#project-reminder"), $("#project-no-reminder"));
  if (reminderDays === null) return;
  const now = new Date().toISOString();
  const project = { id: makeId(), title, status: "active", reminderDays, returnPoint: "", createdAt: now, updatedAt: now, deletedAt: null };
  const saveButton = $("#project-save");
  saveButton.disabled = true;
  try {
    await putRecord(db, "projects", project);
    projects.push(project);
    close("project-dialog");
    $("#project-form").reset();
    syncReminderFields($("#project-reminder"), $("#project-no-reminder"));
    render();
    notice("已添加“" + title + "”。");
  } catch (error) {
    notice("保存失败，名字还留在这里，请重试。", true);
  } finally {
    saveButton.disabled = false;
  }
}

function openProjectDetail(id) {
  const project = projects.find(item => item.id === id);
  if (!project) return;
  $("#detail-title").textContent = project.title;
  $("#detail-subtitle").textContent = statusText(project.status) + " · " + (project.reminderDays ? project.reminderDays + " 天未记录时提示" : "不提醒");
  const body = $("#detail-body");
  body.replaceChildren();
  const returnBlock = node("div", "detail-block");
  returnBlock.append(node("span", "return-label", "下次从哪接"));
  returnBlock.append(node("p", "", project.returnPoint || "还没有写。可以直接看最近一次原话。"));
  body.append(returnBlock);
  const returnLabel = node("label", "", "修改返回点");
  returnLabel.htmlFor = "detail-return-input";
  const returnInput = node("input", "search-input");
  returnInput.id = "detail-return-input";
  returnInput.type = "text";
  returnInput.maxLength = 500;
  returnInput.value = project.returnPoint || "";
  const returnActions = node("div", "thing-actions");
  returnActions.append(button("保存返回点", "save-return", id));
  body.append(returnLabel, returnInput, returnActions);
  const reminderBlock = node("div", "detail-reminder");
  const reminderLabel = node("label", "", "多少天没记录时提醒我看看");
  reminderLabel.htmlFor = "detail-reminder-days";
  const reminderNumber = node("div", "number-field");
  const reminderInput = node("input");
  reminderInput.id = "detail-reminder-days";
  reminderInput.type = "number";
  reminderInput.inputMode = "numeric";
  reminderInput.min = "1";
  reminderInput.max = String(MAX_REMINDER_DAYS);
  reminderInput.step = "1";
  reminderInput.value = String(project.reminderDays || 14);
  reminderNumber.append(reminderInput, node("span", "", "天"));
  const offLabel = node("label", "check-row");
  offLabel.htmlFor = "detail-no-reminder";
  const offInput = node("input");
  offInput.id = "detail-no-reminder";
  offInput.type = "checkbox";
  offInput.checked = !project.reminderDays;
  offLabel.append(offInput, node("span", "", "不提醒"));
  offInput.addEventListener("change", () => syncReminderFields(reminderInput, offInput));
  syncReminderFields(reminderInput, offInput);
  reminderBlock.append(reminderLabel, reminderNumber, offLabel, button("保存提醒", "save-reminder", id));
  body.append(reminderBlock);
  const actions = node("div", "detail-actions");
  if (project.status === "active") {
    actions.append(button("记一下", "capture-project", id, "chip-button emphasis"));
    actions.append(button("暂停", "pause-project", id));
    actions.append(button("标为完成", "complete-project", id));
    actions.append(button("归档", "archive-project", id));
  } else {
    actions.append(button("继续", "resume-project", id, "chip-button emphasis"));
    if (project.status !== "archived") actions.append(button("归档", "archive-project", id));
  }
  actions.append(button("移到回收站", "delete-project", id, "chip-button danger"));
  body.append(actions, node("h3", "detail-subhead", "这件事的记录"));
  const related = visibleEntries(id);
  if (!related.length) body.append(node("p", "empty-inline", "还没有记录。"));
  for (const entry of related) body.append(renderRecordCard(entry));
  show("detail-dialog");
}

function openEntryDetail(id) {
  const entry = entries.find(item => item.id === id);
  if (!entry) return;
  $("#detail-title").textContent = projectName(entry.projectId);
  $("#detail-subtitle").textContent = "发生于 " + niceDate(entry.occurredOn) + " · 记录于 " + niceDate(dayOf(entry.createdAt));
  const body = $("#detail-body");
  body.replaceChildren();
  body.append(node("p", "record-text", entry.content));
  if (entry.returnPoint) body.append(node("p", "detail-block", "当时留下的返回点：" + entry.returnPoint));
  const selectLabel = node("label", "", "关联到哪件事");
  selectLabel.htmlFor = "detail-entry-project";
  const select = node("select", "search-input");
  select.id = "detail-entry-project";
  populateProjectSelect(select, entry.projectId);
  const dateLabel = node("label", "", "发生日期");
  dateLabel.htmlFor = "detail-entry-date";
  dateLabel.className = "detail-field-label";
  const dateInput = node("input", "search-input");
  dateInput.id = "detail-entry-date";
  dateInput.type = "date";
  dateInput.value = entry.occurredOn;
  const actions = node("div", "detail-actions");
  actions.append(button("保存关联和日期", "update-entry", id, "chip-button emphasis"));
  actions.append(button("移到回收站", "delete-entry", id, "chip-button danger"));
  body.append(selectLabel, select, dateLabel, dateInput, actions);
  show("detail-dialog");
}

function openTrash() {
  close("settings-dialog");
  $("#detail-title").textContent = "回收站";
  $("#detail-subtitle").textContent = "这里的内容可以恢复";
  const body = $("#detail-body");
  body.replaceChildren();
  const deletedProjects = projects.filter(item => item.deletedAt);
  const deletedEntries = entries.filter(item => item.deletedAt);
  if (!deletedProjects.length && !deletedEntries.length) body.append(node("p", "empty-inline", "回收站是空的。"));
  for (const project of deletedProjects) {
    const card = node("article", "record-card");
    card.append(node("h3", "", project.title));
    const actions = node("div", "thing-actions");
    actions.append(button("恢复事情", "restore-project", project.id));
    actions.append(button("彻底删除", "purge-project", project.id, "chip-button danger"));
    card.append(actions);
    body.append(card);
  }
  for (const entry of deletedEntries) {
    const card = renderRecordCard(entry);
    const actions = node("div", "thing-actions");
    actions.append(button("恢复记录", "restore-entry", entry.id));
    actions.append(button("彻底删除", "purge-entry", entry.id, "chip-button danger"));
    card.append(actions);
    body.append(card);
  }
  show("detail-dialog");
}

async function changeProject(id, changes) {
  const current = projects.find(item => item.id === id);
  if (!current) return;
  const project = { ...current, ...changes, updatedAt: new Date().toISOString() };
  await putRecord(db, "projects", project);
  projects = projects.map(item => item.id === id ? project : item);
  close("detail-dialog");
  render();
  notice("“" + project.title + "”已更新。");
}

async function changeEntry(id, changes) {
  const current = entries.find(item => item.id === id);
  if (!current) return;
  const entry = { ...current, ...changes, updatedAt: new Date().toISOString() };
  await putRecord(db, "entries", entry);
  entries = entries.map(item => item.id === id ? entry : item);
  close("detail-dialog");
  render();
  notice("记录已更新，原话没有改动。");
}

function backupDocument() {
  return {
    app: "xuji",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    projects,
    entries,
    draft: draft && draft.content ? draft : null
  };
}

function backupFile() {
  const blob = new Blob([JSON.stringify(backupDocument(), null, 2)], { type: "application/json" });
  return new File([blob], "续记备份-" + today() + ".json", { type: "application/json" });
}

async function recordExport() {
  const item = { key: "lastExport", value: new Date().toISOString() };
  await putRecord(db, "meta", item);
  meta = meta.filter(row => row.key !== item.key).concat(item);
  render();
}

async function exportBackup(share = false) {
  const file = backupFile();
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: "续记备份" });
    await recordExport();
    notice("已打开分享。请确认备份文件已存进“文件”。");
    return;
  }
  const url = URL.createObjectURL(file);
  const link = node("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  await recordExport();
  notice("已生成备份文件。请在“文件”的下载位置确认它存在。");
}

function validString(value, max, allowEmpty = true) {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}

function validId(value) {
  return validString(value, 100, false) && /^[a-zA-Z0-9-]+$/.test(value);
}

function validIso(value) {
  return validString(value, 50, false) && !Number.isNaN(Date.parse(value));
}

function validDay(value) {
  return validString(value, 10, false) && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayOf(value + "T12:00:00") === value;
}

function parseBackup(value) {
  if (!value || value.app !== "xuji" || value.formatVersion !== 1 ||
      !Array.isArray(value.projects) || !Array.isArray(value.entries) ||
      value.projects.length > 5000 || value.entries.length > 50000) {
    throw new Error("这不是可识别的续记备份文件。");
  }
  const projectIds = new Set();
  const entryIds = new Set();
  const parsedProjects = value.projects.map(raw => {
    if (!raw || !validId(raw.id) || projectIds.has(raw.id) ||
        !validString(raw.title, 100, false) ||
        !["active", "paused", "completed", "archived"].includes(raw.status) ||
        !validReminderDays(raw.reminderDays) ||
        !validString(raw.returnPoint || "", 500) ||
        !validIso(raw.createdAt) || !validIso(raw.updatedAt) ||
        !(raw.deletedAt === null || raw.deletedAt === undefined || validIso(raw.deletedAt))) {
      throw new Error("备份中的事情数据不完整，未导入任何内容。");
    }
    projectIds.add(raw.id);
    return { id: raw.id, title: raw.title, status: raw.status, reminderDays: raw.reminderDays,
      returnPoint: raw.returnPoint || "", createdAt: raw.createdAt, updatedAt: raw.updatedAt, deletedAt: raw.deletedAt || null };
  });
  const parsedEntries = value.entries.map(raw => {
    if (!raw || !validId(raw.id) || entryIds.has(raw.id) ||
        !(raw.projectId === null || raw.projectId === undefined || validId(raw.projectId)) ||
        !validString(raw.content, 200000, false) ||
        !validDay(raw.occurredOn) || !validString(raw.returnPoint || "", 500) ||
        !validIso(raw.createdAt) || !validIso(raw.updatedAt) ||
        !(raw.deletedAt === null || raw.deletedAt === undefined || validIso(raw.deletedAt))) {
      throw new Error("备份中的记录数据不完整，未导入任何内容。");
    }
    entryIds.add(raw.id);
    return { id: raw.id, projectId: raw.projectId || null, content: raw.content,
      occurredOn: raw.occurredOn, returnPoint: raw.returnPoint || "", createdAt: raw.createdAt,
      updatedAt: raw.updatedAt, deletedAt: raw.deletedAt || null };
  });
  let parsedDraft = null;
  if (value.draft !== null && value.draft !== undefined) {
    const raw = value.draft;
    if (!raw || !validString(raw.content, 200000, false) ||
        !(raw.projectId === null || raw.projectId === undefined || validId(raw.projectId)) ||
        !validDay(raw.occurredOn) || !validString(raw.returnPoint || "", 500) ||
        (raw.savedAt && !validIso(raw.savedAt))) {
      throw new Error("备份中的草稿数据不完整，未导入任何内容。");
    }
    parsedDraft = { content: raw.content, projectId: raw.projectId || null,
      occurredOn: raw.occurredOn, returnPoint: raw.returnPoint || "",
      savedAt: raw.savedAt || value.exportedAt || new Date().toISOString() };
  }
  return { projects: parsedProjects, entries: parsedEntries, draft: parsedDraft };
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) throw new Error("备份文件超过 25 MB，暂时无法导入。");
  let source;
  try {
    source = JSON.parse(await file.text());
  } catch (error) {
    throw new Error("文件不是有效的 JSON 备份。");
  }
  const backup = parseBackup(source);
  const existingProjectIds = new Set(projects.map(item => item.id));
  const existingEntryIds = new Set(entries.map(item => item.id));
  const addProjects = backup.projects.filter(item => !existingProjectIds.has(item.id)).length;
  const addEntries = backup.entries.filter(item => !existingEntryIds.has(item.id)).length;
  const skipped = backup.projects.length + backup.entries.length - addProjects - addEntries;
  if (!window.confirm("将新增 " + addProjects + " 件事情、" + addEntries + " 条记录；已有的 " + skipped + " 项会跳过，不会覆盖。确定导入吗？")) return;
  const result = await mergeMissing(db, backup.projects, backup.entries, existingProjectIds, existingEntryIds);
  let addedDraft = false;
  if (backup.draft && !(draft && draft.content)) {
    await putRecord(db, "meta", { key: "captureDraft", value: backup.draft });
    cacheDraftLocally(backup.draft);
    addedDraft = true;
  }
  await refresh();
  notice("已恢复 " + result.projects + " 件事情、" + result.entries + " 条记录；跳过已有 " + result.skipped + " 项。" +
    (addedDraft ? "另恢复了 1 份草稿。" : ""));
}

async function refresh() {
  const data = await readAll(db);
  projects = data.projects;
  entries = data.entries;
  meta = data.meta;
  const databaseDraft = meta.find(item => item.key === "captureDraft")?.value || null;
  const localDraft = cachedDraft();
  draft = localDraft && (!databaseDraft || (localDraft.savedAt || "") >= (databaseDraft.savedAt || ""))
    ? localDraft : databaseDraft;
  render();
}

async function handleAction(action, id) {
  if (action === "capture-project") { close("detail-dialog"); openCapture(id); return; }
  if (action === "project-detail") { openProjectDetail(id); return; }
  if (action === "entry-detail") { openEntryDetail(id); return; }
  if (action === "pause-project") return changeProject(id, { status: "paused" });
  if (action === "resume-project") return changeProject(id, { status: "active" });
  if (action === "complete-project") return changeProject(id, { status: "completed" });
  if (action === "archive-project") return changeProject(id, { status: "archived" });
  if (action === "save-return") return changeProject(id, { returnPoint: $("#detail-return-input").value.trim() });
  if (action === "save-reminder") {
    const reminderDays = reminderFromFields($("#detail-reminder-days"), $("#detail-no-reminder"));
    if (reminderDays === null) return;
    return changeProject(id, { reminderDays });
  }
  if (action === "update-entry") {
    const projectId = $("#detail-entry-project").value || null;
    const occurredOn = $("#detail-entry-date").value;
    if (!validDay(occurredOn)) throw new Error("请选择有效的发生日期。");
    return changeEntry(id, { projectId, occurredOn });
  }
  if (action === "delete-project") {
    if (window.confirm("把这件事移到回收站？它的记录仍会保留。")) return changeProject(id, { deletedAt: new Date().toISOString() });
    return;
  }
  if (action === "delete-entry") {
    if (window.confirm("把这条记录移到回收站？之后可以恢复。")) return changeEntry(id, { deletedAt: new Date().toISOString() });
    return;
  }
  if (action === "restore-project") {
    await changeProject(id, { deletedAt: null });
    openTrash();
    return;
  }
  if (action === "restore-entry") { await changeEntry(id, { deletedAt: null }); openTrash(); return; }
  if (action === "purge-entry") {
    if (!window.confirm("彻底删除这条原话？这一步无法撤销，备份文件除外。")) return;
    await removeRecord(db, "entries", id);
    entries = entries.filter(item => item.id !== id);
    render();
    openTrash();
    return;
  }
  if (action === "purge-project") {
    if (!window.confirm("彻底删除这件事？相关记录会变成未分类，原话不会删除。")) return;
    const linked = entries.filter(item => item.projectId === id);
    await removeProjectForever(db, id, linked);
    projects = projects.filter(item => item.id !== id);
    entries = entries.map(item => item.projectId === id ? { ...item, projectId: null } : item);
    render();
    openTrash();
  }
}

async function start() {
  try {
    db = await openDatabase();
    await refresh();
  } catch (error) {
    notice(error.message || "本地存储无法打开。请不要在这里输入重要内容。", true);
    $("#capture-open").disabled = true;
    $("#project-open").disabled = true;
    $("#search-input").disabled = true;
    return;
  }

  $("#capture-open").addEventListener("click", () => openCapture());
  $("#project-open").addEventListener("click", () => {
    show("project-dialog");
    $("#project-title").focus();
  });
  $("#project-no-reminder").addEventListener("change", () =>
    syncReminderFields($("#project-reminder"), $("#project-no-reminder")));
  $("#settings-open").addEventListener("click", () => show("settings-dialog"));
  const onIphone = /iPhone/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  $("#ios-install-warning").hidden = !onIphone || standalone;
  $("#ios-install-help").addEventListener("click", () => show("settings-dialog"));
  $("#capture-form").addEventListener("submit", saveEntry);
  $("#project-form").addEventListener("submit", saveProject);
  $("#search-input").addEventListener("input", renderSearch);
  $("#project-filter").addEventListener("input", render);
  for (const field of $("#capture-form").querySelectorAll("textarea, input, select")) {
    field.addEventListener("input", scheduleDraft);
    field.addEventListener("change", scheduleDraft);
  }
  document.addEventListener("click", async event => {
    const closer = event.target.closest("[data-close]");
    if (closer) {
      if (closer.dataset.close === "capture-dialog") {
        try { await flushDraft(); } catch (error) { notice("草稿暂时没保存，关掉页面前先复制出来。", true); return; }
      }
      close(closer.dataset.close);
      return;
    }
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    try { await handleAction(trigger.dataset.action, trigger.dataset.id); }
    catch (error) { notice(error.message || "操作没完成，请重试。", true); }
  });
  $("#capture-dialog").addEventListener("cancel", event => {
    event.preventDefault();
    flushDraft().then(() => close("capture-dialog")).catch(() => notice("草稿暂时没保存，请先复制出来。", true));
  });
  $("#export-button").addEventListener("click", () => exportBackup(false).catch(() => notice("备份没能导出，请重试。", true)));
  if (navigator.canShare) $("#share-button").hidden = false;
  $("#share-button").addEventListener("click", () => exportBackup(true).catch(error => {
    if (error.name !== "AbortError") notice("分享没有完成，可以试试“导出备份”。", true);
  }));
  $("#import-file").addEventListener("change", event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    importBackup(file).catch(error => notice(error.message || "导入失败，原有记录没有被覆盖。", true));
  });
  $("#trash-open").addEventListener("click", openTrash);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
}

start();
