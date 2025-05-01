// 文件: public/extensions/third-party/day5/worker.js

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1;
let db;

const GLOBAL_STATS_ID = '_GLOBAL_STATS_';

// --- IndexedDB 辅助函数 ---
function openDB() {
    return new Promise((resolve, reject) => {
        if (db) { resolve(db); return; }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => { console.error('Day1 Worker: DB open error:', event.target.error); reject('IndexedDB error: ' + event.target.error); };
        request.onsuccess = (event) => {
            db = event.target.result;
            db.onerror = (event) => console.error("Day1 Worker: Database error:", event.target.error);
            db.onclose = () => { db = null; };
            db.onversionchange = () => { if (db) db.close(); db = null; };
            resolve(db);
        };
        request.onupgradeneeded = (event) => { console.log("Day1 Worker: DB upgrade needed."); };
    });
}
function readData(entityId) { /* ... (保持不变) ... */
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(entityId);
            request.onerror = (event) => reject('Error reading data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result);
        } catch (error) {
            console.error("Day1 Worker: Error during readData transaction setup:", error);
            reject(error);
        }
    });
}
function writeData(data) { /* ... (保持不变) ... */
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data);
            request.onerror = (event) => reject('Error writing data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result);
        } catch (error) {
            console.error("Day1 Worker: Error during writeData transaction setup:", error);
            reject(error);
        }
    });
}

// --- 修改：getOrCreateDailyStat 添加 dailyInteractionDurationMs (用于实体) ---
/**
 * 获取或初始化指定实体在指定日期的统计数据对象。
 * @param {object} stats - 整个实体的统计对象。
 * @param {string} dateString - YYYY-MM-DD 格式的日期字符串。
 * @param {string} entityId - 实体ID，用于区分全局统计。
 * @returns {object} 当天的统计数据对象。
 */
function getOrCreateDailyStat(stats, dateString, entityId) {
    if (!stats.dailyData) stats.dailyData = {};
    const isGlobal = entityId === GLOBAL_STATS_ID;

    if (!stats.dailyData[dateString]) {
        stats.dailyData[dateString] = { totalVisibleDurationMs: 0 }; // 全局基础
        if (!isGlobal) {
            Object.assign(stats.dailyData[dateString], {
                userMessages: 0, aiMessages: 0, userTokens: 0, aiTokens: 0,
                cumulativeTokens: 0, lastUserMessageTimestamp: null, lastAiMessageTimestamp: null,
                totalAiResponseDuration: 0, dailyInteractionDurationMs: 0, // *** 新增当日实体时长 ***
            });
        }
        // console.log(`Day1 Worker: Created new daily entry for ${entityId} on ${dateString}`);
    }

    // 确保字段存在
    stats.dailyData[dateString].totalVisibleDurationMs = stats.dailyData[dateString].totalVisibleDurationMs || 0;
    if (!isGlobal) {
        stats.dailyData[dateString].userTokens = stats.dailyData[dateString].userTokens || 0;
        stats.dailyData[dateString].aiTokens = stats.dailyData[dateString].aiTokens || 0;
        stats.dailyData[dateString].cumulativeTokens = stats.dailyData[dateString].cumulativeTokens || 0;
        stats.dailyData[dateString].lastUserMessageTimestamp = stats.dailyData[dateString].lastUserMessageTimestamp || null;
        stats.dailyData[dateString].lastAiMessageTimestamp = stats.dailyData[dateString].lastAiMessageTimestamp || null;
        stats.dailyData[dateString].totalAiResponseDuration = stats.dailyData[dateString].totalAiResponseDuration || 0;
        // *** 确保当日实体时长字段存在 ***
        stats.dailyData[dateString].dailyInteractionDurationMs = stats.dailyData[dateString].dailyInteractionDurationMs || 0;
    }
    return stats.dailyData[dateString];
}


// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    if (!event.data?.command) return;
    const { command, payload } = event.data;

    // 处理 'processMessage' 命令 (保持不变)
    if (command === 'processMessage') {
        if (!payload?.entityId || !payload.timestamp) return;
        const { entityId, entityName, isUser, tokenCount, timestamp, aiResponseDuration } = payload;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            if (entityName && stats.entityName !== entityName) stats.entityName = entityName;
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            if (isUser === true) {
                dailyStat.userMessages = (dailyStat.userMessages || 0) + 1; dailyStat.userTokens += Number(tokenCount) || 0; dailyStat.lastUserMessageTimestamp = timestamp;
            } else if (isUser === false) {
                dailyStat.aiMessages = (dailyStat.aiMessages || 0) + 1; dailyStat.aiTokens += Number(tokenCount) || 0; dailyStat.lastAiMessageTimestamp = timestamp;
                if (typeof aiResponseDuration === 'number' && aiResponseDuration >= 0) dailyStat.totalAiResponseDuration += aiResponseDuration;
            }
            await writeData(stats);
        } catch (error) { console.error(`Worker Error (processMessage ${entityId}):`, error); }
    }
    // 处理 'recordPromptTokens' 命令 (保持不变)
    else if (command === 'recordPromptTokens') {
        if (!payload?.entityId || !payload.timestamp || typeof payload.promptTokenCount !== 'number') return;
        const { entityId, entityName, timestamp, promptTokenCount } = payload;
         try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            if (entityName && stats.entityName !== entityName) stats.entityName = entityName;
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.cumulativeTokens += Number(promptTokenCount) || 0;
            await writeData(stats);
        } catch (error) { console.error(`Worker Error (recordPromptTokens ${entityId}):`, error); }
    }
    // 处理 'recordDailyDuration' 命令 (保持不变)
    else if (command === 'recordDailyDuration') {
        if (typeof payload?.durationMs !== 'number' || !payload.timestamp) return;
        const { durationMs, timestamp } = payload;
        const entityId = GLOBAL_STATS_ID;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) stats = { entityId, entityName: 'Global Stats', dailyData: {} };
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.totalVisibleDurationMs += durationMs;
            await writeData(stats);
        } catch (error) { console.error(`Worker Error (recordDailyDuration):`, error); }
    }
    // --- 修改：处理 'recordEntityDuration' 命令以更新当日实体时长 ---
    else if (command === 'recordEntityDuration') {
        if (!payload?.entityId || typeof payload.durationMs !== 'number' || !payload.timestamp) { // *** 确保 timestamp 存在 ***
            console.warn('Day1 Worker: Received recordEntityDuration with missing data.', payload); return;
        }
        const { entityId, entityName, durationMs, timestamp } = payload; // *** 解构出 timestamp ***

        try {
            let stats = await readData(entityId);
            if (!stats) {
                stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            }
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;

            // 更新总时长
            stats.totalInteractionDurationMs += durationMs;

            // *** 更新当日时长 ***
            let date = new Date(timestamp); // *** 使用传入的时间戳确定日期 ***
            if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.dailyInteractionDurationMs += durationMs; // *** 累加到当日实体时长 ***

            await writeData(stats);
            // console.log(`Worker: Recorded entity duration ${durationMs}ms for ${entityId}. New total: ${stats.totalInteractionDurationMs}ms, New daily: ${dailyStat.dailyInteractionDurationMs}ms`);
        } catch (error) {
            console.error(`Worker Error (recordEntityDuration ${entityId}):`, error);
        }
    }
};

// --- Worker 初始化 ---
console.log('Day1 Worker: Script loaded.');
openDB().then(() => { console.log("Day1 Worker: Initial DB check successful."); })
        .catch(e => { console.error("Day1 Worker: Initial DB check failed.", e); });
