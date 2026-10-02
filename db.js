const DATABASE = "xuji-device-data";
const VERSION = 1;

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("读取失败"));
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("保存中断"));
    transaction.onerror = () => reject(transaction.error || new Error("保存失败"));
  });
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error("这台设备当前无法使用本地存储。请用 Safari 打开，并检查是否处于无痕浏览。"));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地数据库打不开"));
    request.onblocked = () => reject(new Error("请关闭其他打开的续记页面，再重新试一次。"));
  });
}

export async function readAll(db) {
  const transaction = db.transaction(["projects", "entries", "meta"], "readonly");
  const projects = result(transaction.objectStore("projects").getAll());
  const entries = result(transaction.objectStore("entries").getAll());
  const meta = result(transaction.objectStore("meta").getAll());
  return { projects: await projects, entries: await entries, meta: await meta };
}

export async function putRecord(db, store, value) {
  const transaction = db.transaction(store, "readwrite");
  const done = finished(transaction);
  transaction.objectStore(store).put(value);
  await done;
}

export async function putEntryAndProject(db, entry, project) {
  const transaction = db.transaction(["entries", "projects"], "readwrite");
  const done = finished(transaction);
  transaction.objectStore("entries").put(entry);
  if (project) transaction.objectStore("projects").put(project);
  await done;
}

export async function removeRecord(db, store, id) {
  const transaction = db.transaction(store, "readwrite");
  const done = finished(transaction);
  transaction.objectStore(store).delete(id);
  await done;
}

export async function mergeMissing(db, projects, entries, existingProjectIds, existingEntryIds) {
  const newProjects = projects.filter(project => !existingProjectIds.has(project.id));
  const newEntries = entries.filter(entry => !existingEntryIds.has(entry.id));
  const transaction = db.transaction(["projects", "entries"], "readwrite");
  const done = finished(transaction);
  for (const project of newProjects) transaction.objectStore("projects").add(project);
  for (const entry of newEntries) transaction.objectStore("entries").add(entry);
  await done;
  return { projects: newProjects.length, entries: newEntries.length, skipped: projects.length + entries.length - newProjects.length - newEntries.length };
}

export async function removeProjectForever(db, projectId, linkedEntries) {
  const transaction = db.transaction(["projects", "entries"], "readwrite");
  const done = finished(transaction);
  transaction.objectStore("projects").delete(projectId);
  for (const entry of linkedEntries) transaction.objectStore("entries").put({ ...entry, projectId: null });
  await done;
}
