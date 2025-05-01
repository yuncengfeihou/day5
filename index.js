// 文件: public/extensions/third-party/day5/index.js

import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

(function () {
    // --- 插件基础信息 ---
    const extensionName = "day5";
    const pluginFolderName = "day5";
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker;
    // Prompt Token 追踪
    let lastCalculatedPromptTokens = 0;
    let lastUsedApi = '';
    let pendingTokenConsumptionLog = false;
    // 时长追踪
    let lastVisibleTimestamp = null;
    let currentEntityId = null;
    let currentEntityName = null;
    let entityStartTime = null;

    const GLOBAL_STATS_ID = '_GLOBAL_STATS_';

    // --- IndexedDB 相关 (保持不变) ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) { resolve(dbInstance); return; }
            // console.log(`[${extensionName}] Main: Opening IndexedDB...`);
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => { console.error(`[${extensionName}] Main: IndexedDB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); };
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                // console.log(`[${extensionName}] Main: IndexedDB connection opened.`);
                dbInstance.onerror = (event) => console.error(`[${extensionName}] Main: Database error:`, event.target.error);
                dbInstance.onclose = () => { /* console.log(`[${extensionName}] Main: Database connection closed.`); */ dbInstance = null; };
                dbInstance.onversionchange = () => { console.log(`[${extensionName}] Main: Database version change detected, closing connection.`); if (dbInstance) { dbInstance.close(); dbInstance = null; } };
                resolve(dbInstance);
            };
            request.onupgradeneeded = (event) => {
                console.log(`[${extensionName}] Main: IndexedDB upgrade needed.`);
                const db = event.target.result;
                const transaction = event.target.transaction;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    try {
                        db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                        console.log(`[${extensionName}] Main: Object store "${STORE_NAME}" created.`);
                    } catch (e) {
                         console.error(`[${extensionName}] Main: Error creating object store "${STORE_NAME}"`, e);
                         if (transaction) transaction.abort();
                         reject(`Error creating object store: ${e}`);
                         return;
                    }
                }
                console.log(`[${extensionName}] Main: IndexedDB upgrade finished.`);
            };
        });
    }

    function getAllStats() {
        return new Promise(async (resolve, reject) => {
            try {
                const db = await openDBMain();
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();
                request.onerror = (event) => reject('Error reading all data: ' + event.target.error);
                request.onsuccess = (event) => resolve(event.target.result || []);
            } catch (error) {
                console.error(`[${extensionName}] Main: Error during getAllStats:`, error);
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) { console.error(`[${extensionName}] Main: Worker not initialized! Cannot send message.`); return; }
        try {
             day1Worker.postMessage({ command, payload });
        } catch (error) {
             console.error(`[${extensionName}] Main: Error posting message to worker:`, error, { command, payload });
        }
    }

    // --- 时长处理函数 ---
    function recordVisibleDuration() {
        if (lastVisibleTimestamp) {
            const durationMs = Date.now() - lastVisibleTimestamp;
            if (durationMs > 0) {
                sendMessageToWorker('recordDailyDuration', {
                    durationMs: durationMs,
                    timestamp: Date.now(),
                });
            }
            lastVisibleTimestamp = null;
        }
    }

    /** 记录当前活动实体的交互时长片段到 Worker (包含时间戳) */
    function recordEntityDuration() {
        if (entityStartTime && currentEntityId) {
            const durationMs = Date.now() - entityStartTime;
            if (durationMs > 0) {
                sendMessageToWorker('recordEntityDuration', {
                    entityId: currentEntityId,
                    entityName: currentEntityName,
                    durationMs: durationMs,
                    timestamp: Date.now(), // *** 新增：传递时间戳 ***
                });
            }
            entityStartTime = null;
        }
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'visible') {
            lastVisibleTimestamp = Date.now();
            if (currentEntityId) {
                entityStartTime = Date.now();
            }
        } else {
            recordVisibleDuration();
            recordEntityDuration();
        }
    }

    // --- UI 更新 (需要修改以显示新时长数据) ---
    function formatDuration(ms) {
        if (typeof ms !== 'number' || ms <= 0) return '0s';
        let seconds = Math.floor(ms / 1000);
        let minutes = Math.floor(seconds / 60);
        let hours = Math.floor(minutes / 60);
        seconds %= 60; minutes %= 60;
        let result = '';
        if (hours > 0) result += `${hours}h `;
        if (minutes > 0) result += `${minutes}m `;
        if (seconds >= 0) result += `${seconds}s`;
        return result.trim();
    }

    async function updateStatsTable() {
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) return;
        // *** 修改 colspan 以适应新列 ***
        tableBody.empty().append('<tr><td colspan="8"><i>正在加载统计数据...</i></td></tr>');

        try {
            const allStats = await getAllStats();
            const todayString = new Date().toISOString().split('T')[0];
            tableBody.empty();

            if (allStats.length === 0) {
                 tableBody.append('<tr><td colspan="8"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            const globalStatEntry = allStats.find(s => s.entityId === GLOBAL_STATS_ID);
            const dailyGlobalData = globalStatEntry?.dailyData?.[todayString];
            const todayTotalDurationStr = formatDuration(dailyGlobalData?.totalVisibleDurationMs);

            let hasTodayData = false;
            const entityStatsList = allStats
                .filter(s => s.entityId !== GLOBAL_STATS_ID)
                .sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            entityStatsList.forEach(entityStats => {
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;

                const userMessages = dailyData?.userMessages || 0;
                const userTokens = dailyData?.userTokens || 0;
                const aiMessages = dailyData?.aiMessages || 0;
                const aiTokens = dailyData?.aiTokens || 0;
                const cumulativeTokens = dailyData?.cumulativeTokens || 0;
                const totalAiDurationMs = dailyData?.totalAiResponseDuration || 0;
                // *** 读取每日角色/群组时长 ***
                const dailyEntityDurationMs = dailyData?.dailyInteractionDurationMs || 0;

                let avgAiTimeStr = 'N/A';
                if (aiMessages > 0 && totalAiDurationMs > 0) {
                    avgAiTimeStr = `${(totalAiDurationMs / aiMessages / 1000).toFixed(2)}s`;
                }

                const totalInteractionDurationStr = formatDuration(entityStats.totalInteractionDurationMs);
                // *** 格式化每日角色/群组时长 ***
                const dailyEntityDurationStr = formatDuration(dailyEntityDurationMs);

                hasTodayData = hasTodayData || !!dailyData;

                // *** 修改 row 结构以包含所有列 ***
                const row = `
                    <tr>
                        <td>${entityStats.entityName || entityStats.entityId}</td>
                        <td>${userMessages} (${userTokens} tk)</td>
                        <td>${aiMessages} (${aiTokens} tk)</td>
                        <td>${cumulativeTokens} tk</td>             <%-- Prompt Tokens --%>
                        <td>${avgAiTimeStr}</td>                   <%-- 平均 AI 响应时间 --%>
                        <td>${dailyEntityDurationStr}</td>        <%-- 新增：角色/群组今日时长 --%>
                        <td>${totalInteractionDurationStr}</td>   <%-- 角色/群组总时长 --%>
                        <td>${todayTotalDurationStr}</td>         <%-- 今日总在线时长 --%>
                    </tr>
                `;
                tableBody.append(row);
            });

            if (!hasTodayData && entityStatsList.length === 0) {
                 tableBody.append(`<tr><td colspan="8"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }

        } catch (error) {
            console.error(`[${extensionName}] Main: Error fetching or updating stats table:`, error);
            tableBody.empty().append('<tr><td colspan="8"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>');
        }
    }


    // --- 事件处理 (handleMessage, onMessageSent 保持不变) ---
    async function handleMessage(message, isUser) {
        if (!message || !currentEntityId) return;
        let tokenCount = 0;
        try {
            tokenCount = (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0)
                ? message.extra.token_count
                : (message.mes ? await getTokenCountAsync(message.mes || '', 0) : 0);
        } catch (err) { tokenCount = Math.round((message.mes || '').length / 3.5); }
        let aiResponseDuration = null;
        if (!isUser && message.gen_finished && message.gen_started) {
            try {
                const end = new Date(message.gen_finished).getTime();
                const start = new Date(message.gen_started).getTime();
                if (!isNaN(end) && !isNaN(start) && end >= start) aiResponseDuration = end - start;
            } catch (e) { /* ignore */ }
        }
        sendMessageToWorker('processMessage', {
            entityId: currentEntityId, entityName: currentEntityName, isUser, tokenCount,
            timestamp: message.send_date || Date.now(), aiResponseDuration,
        });
    }
    function onMessageSent(messageId) {
        const context = getContext();
        if (context?.chat?.[messageId]) handleMessage(context.chat[messageId], true);
    }
    function onChatChanged(chatId) {
        const context = getContext();
        let newEntityId = null, newEntityName = null;
        if (context) {
            if (context.groupId != null) {
                newEntityId = String(context.groupId);
                newEntityName = context.groups?.find(g => String(g.id) === newEntityId)?.name || newEntityId;
            } else if (context.characterId != null && context.characters?.[context.characterId]) {
                newEntityId = context.characters[context.characterId].avatar;
                newEntityName = context.characters[context.characterId].name;
            }
        }
        if (document.visibilityState === 'visible') recordEntityDuration();
        if (newEntityId !== currentEntityId) {
            currentEntityId = newEntityId;
            currentEntityName = newEntityName;
            entityStartTime = (document.visibilityState === 'visible' && currentEntityId) ? Date.now() : null;
            pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0; lastUsedApi = '';
            updateStatsTable();
        } else if (newEntityId === null && currentEntityId !== null) {
             currentEntityId = null; currentEntityName = null; entityStartTime = null;
        }
    }


    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`[${extensionName}] Main: Initializing extension...`);
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        try { await openDBMain(); } catch (error) { console.error(`[${extensionName}] Main: DB init failed:`, error); }
        try {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            const targetContainer = $('#extensions_settings') || $('#extension_settings') || $('body');
            if (targetContainer.length) {
                targetContainer.append(settingsHtml);
                $('#day1-refresh-button').on('click', updateStatsTable);
                setTimeout(updateStatsTable, 500);
            }
        } catch (error) { console.error(`[${extensionName}] Main: Error loading settings UI:`, error); }
        try {
            const workerPath = `${extensionFolderPath}/worker.js`;
            day1Worker = new Worker(workerPath);
            day1Worker.onerror = (error) => { console.error(`[${extensionName}] Worker error:`, error.message, error); };
            console.log(`[${extensionName}] Main: Web Worker initialized.`);
        } catch (error) { console.error(`[${extensionName}] Main: Failed to initialize Worker:`, error); day1Worker = null; }

        // --- 注册核心事件监听器 ---
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.GENERATE_AFTER_DATA, async (generateData) => {
            const context = getContext();
            const currentApi = generateData.type || context.mainApi || mainApi;
            if (generateData.dryRun || !currentEntityId) return;
            try {
                let promptTokens = 0;
                if (currentApi === 'openai' || generateData.is_openai) {
                    if (Array.isArray(generateData.prompt)) promptTokens = (await Promise.all(generateData.prompt.map(m => getTokenCountAsync(m.content || '', 0)))).reduce((s, c) => s + c, 0);
                } else if (typeof generateData.prompt === 'string') {
                    promptTokens = await getTokenCountAsync(generateData.prompt, power_user?.token_padding || 0);
                }
                lastCalculatedPromptTokens = promptTokens; lastUsedApi = currentApi; pendingTokenConsumptionLog = true;
            } catch (error) { pendingTokenConsumptionLog = false; }
        });
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
            const context = getContext();
            if (context?.chat?.[messageId] && !context.chat[messageId].is_user && !context.chat[messageId].is_system) handleMessage(context.chat[messageId], false);
            if (pendingTokenConsumptionLog && currentEntityId) {
                sendMessageToWorker('recordPromptTokens', { entityId: currentEntityId, entityName: currentEntityName, timestamp: Date.now(), promptTokenCount: lastCalculatedPromptTokens });
                pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0;
            }
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => { if (pendingTokenConsumptionLog) { pendingTokenConsumptionLog = false; lastCalculatedPromptTokens = 0; } });

        // --- 添加 visibilitychange 监听器 ---
        document.addEventListener('visibilitychange', handleVisibilityChange);
        // --- 初始化时处理当前状态 ---
        onChatChanged(getContext()?.chatId);
        if (document.visibilityState === 'visible') handleVisibilityChange();

        console.log(`[${extensionName}] Main: Initialization complete.`);
    });

})();
