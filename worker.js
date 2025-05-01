// 文件: public/extensions/third-party/day4/worker.js

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1;
let db;

// --- IndexedDB 辅助函数 (保持不变) ---
function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }
        console.log("Day1 Worker: Attempting to open IndexedDB...");
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => {
            console.error('Day1 Worker: IndexedDB open error:', event.target.error);
            reject('IndexedDB error: ' + event.target.error);
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB connection opened successfully.');
            db.onerror = (event) => console.error("Day1 Worker: Database error:", event.target.error);
            db.onclose = () => { console.log("Day1 Worker: Database connection closed."); db = null; };
            db.onversionchange = () => { console.log("Day1 Worker: Database version change detected, closing connection."); if (db) { db.close(); db = null; } };
            resolve(db);
        };
        // onupgradeneeded 应该在 main thread 处理，worker 假定 store 已存在
        request.onupgradeneeded = (event) => {
             console.log("Day1 Worker: onupgradeneeded triggered in worker, main thread should handle creation.");
             // 如果需要 worker 自己创建 (不推荐):
             // const db = event.target.result;
             // if (!db.objectStoreNames.contains(STORE_NAME)) {
             //     db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
             // }
        };
    });
}

function readData(entityId) {
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

function writeData(data) {
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

// --- 修改：添加 totalAiResponseDuration 字段 ---
/**
 * 获取或初始化指定日期的统计数据对象。
 * @param {object} stats - 整个实体的统计对象。
 * @param {string} dateString - YYYY-MM-DD 格式的日期字符串。
 * @returns {object} 当天的统计数据对象。
 */
function getOrCreateDailyStat(stats, dateString) {
    if (!stats.dailyData) {
        stats.dailyData = {};
    }
    if (!stats.dailyData[dateString]) {
        stats.dailyData[dateString] = {
            userMessages: 0,
            aiMessages: 0,
            userTokens: 0,
            aiTokens: 0,
            cumulativeTokens: 0,
            lastUserMessageTimestamp: null,
            lastAiMessageTimestamp: null,
            totalAiResponseDuration: 0, // 新增：AI响应总时长 (毫秒)
        };
        console.log(`Day1 Worker: Creating new daily entry for ${stats.entityId} on ${dateString}`);
    }
    // 确保新字段存在于旧记录中
    stats.dailyData[dateString].userTokens = stats.dailyData[dateString].userTokens || 0;
    stats.dailyData[dateString].aiTokens = stats.dailyData[dateString].aiTokens || 0;
    stats.dailyData[dateString].cumulativeTokens = stats.dailyData[dateString].cumulativeTokens || 0;
    stats.dailyData[dateString].lastUserMessageTimestamp = stats.dailyData[dateString].lastUserMessageTimestamp || null;
    stats.dailyData[dateString].lastAiMessageTimestamp = stats.dailyData[dateString].lastAiMessageTimestamp || null;
    stats.dailyData[dateString].totalAiResponseDuration = stats.dailyData[dateString].totalAiResponseDuration || 0; // 确保旧记录有此字段

    return stats.dailyData[dateString];
}


// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    if (!event.data || !event.data.command) {
        console.warn("Day1 Worker: Received invalid message format.");
        return;
    }

    const { command, payload } = event.data;

    // --- 修改：处理 'processMessage' 命令以包含 AI 响应时间 ---
    if (command === 'processMessage') {
        if (!payload || !payload.entityId || !payload.timestamp) {
             console.warn('Day1 Worker: Received processMessage command with missing payload data.', payload);
             return;
        }
        // --- 解构出 aiResponseDuration ---
        const { entityId, entityName, isUser, tokenCount, timestamp, aiResponseDuration } = payload;

        try {
            let date;
            try {
                date = new Date(timestamp);
                if (isNaN(date.getTime())) { date = new Date(); }
            } catch (e) { date = new Date(); }
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            if (!stats) {
                stats = {
                    entityId: entityId,
                    entityName: entityName || entityId,
                    dailyData: {},
                };
            }
            // 更新实体名称
            if (entityName && stats.entityName !== entityName) {
                stats.entityName = entityName;
            }

            // 获取或创建当天的统计对象
            const dailyStat = getOrCreateDailyStat(stats, dateString);

            // 更新消息计数、Token 计数和时间戳
            if (isUser === true) {
                dailyStat.userMessages += 1;
                dailyStat.userTokens += Number(tokenCount) || 0;
                dailyStat.lastUserMessageTimestamp = timestamp;
            } else if (isUser === false) {
                dailyStat.aiMessages += 1;
                dailyStat.aiTokens += Number(tokenCount) || 0;
                dailyStat.lastAiMessageTimestamp = timestamp;
                // --- 累加 AI 响应时长 ---
                if (typeof aiResponseDuration === 'number' && aiResponseDuration >= 0) {
                    dailyStat.totalAiResponseDuration += aiResponseDuration;
                }
                // ------------------------
            }

            await writeData(stats);
            // console.log(`Day1 Worker: Processed message for ${entityId}. Total AI Duration: ${dailyStat.totalAiResponseDuration}ms`);

        } catch (error) {
            console.error(`Day1 Worker: Error processing message for entity ${entityId}:`, error);
        }
    }
    // 处理 'recordPromptTokens' 命令 (保持不变)
    else if (command === 'recordPromptTokens') {
        if (!payload || !payload.entityId || !payload.timestamp || typeof payload.promptTokenCount !== 'number') {
            console.warn('Day1 Worker: Received recordPromptTokens command with missing payload data.', payload);
            return;
        }
        const { entityId, entityName, timestamp, promptTokenCount } = payload;

         try {
            let date;
            try {
                date = new Date(timestamp);
                if (isNaN(date.getTime())) { date = new Date(); }
            } catch (e) { date = new Date(); }
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            if (!stats) {
                stats = {
                    entityId: entityId,
                    entityName: entityName || entityId,
                    dailyData: {},
                };
            }
            if (entityName && stats.entityName !== entityName) {
                stats.entityName = entityName;
            }

            const dailyStat = getOrCreateDailyStat(stats, dateString);
            dailyStat.cumulativeTokens += Number(promptTokenCount) || 0;
            // console.log(`Day1 Worker: Recorded ${promptTokenCount} prompt tokens for ${entityId} on ${dateString}. New total: ${dailyStat.cumulativeTokens}`);

            await writeData(stats);

        } catch (error) {
            console.error(`Day1 Worker: Error recording prompt tokens for entity ${entityId}:`, error);
        }
    }
};

// --- Worker 初始化 (保持不变) ---
console.log('Day1 Worker: Script loaded and initializing.');
openDB().then(() => {
    console.log("Day1 Worker: Initial DB connection attempt successful.");
}).catch(e => {
    console.error("Day1 Worker: Initial DB connection attempt failed.", e);
});
