// 文件: public/extensions/third-party/day4/index.js

import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';


(function () {
    // --- 插件基础信息 ---
    const extensionName = "day4";
    const pluginFolderName = "day4"; // 与你的文件夹名称匹配
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker;
    let currentEntityId = null;
    let currentEntityName = null;
    // **新增：用于追踪待确认消耗的 Prompt Token 的状态变量**
    let lastCalculatedPromptTokens = 0;
    let lastUsedApi = ''; // 记录计算时使用的 API 类型
    let pendingTokenConsumptionLog = false; // 关键标志位，true表示已预计算Token，等待API成功响应

    // --- IndexedDB 相关 ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    // --- IndexedDB 函数 (保持不变) ---
    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) { resolve(dbInstance); return; }
            console.log(`[${extensionName}] Main: Attempting to open IndexedDB...`);
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => { console.error(`[${extensionName}] Main: IndexedDB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); };
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log(`[${extensionName}] Main: IndexedDB connection opened successfully.`);
                dbInstance.onerror = (event) => console.error(`[${extensionName}] Main: Database error:`, event.target.error);
                dbInstance.onclose = () => { console.log(`[${extensionName}] Main: Database connection closed.`); dbInstance = null; };
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

    // --- UI 更新 (你需要修改这里来显示 AI 响应时间) ---
    async function updateStatsTable() {
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) { /* console.warn(`[${extensionName}] Main: Stats table body not found in DOM.`); */ return; }
        tableBody.empty().append('<tr><td colspan="5"><i>正在加载统计数据...</i></td></tr>'); // 调整 colspan 以适应新列

        try {
            const allStats = await getAllStats();
            const todayString = new Date().toISOString().split('T')[0];
            tableBody.empty();

            if (allStats.length === 0) {
                tableBody.append('<tr><td colspan="6"><i>暂无任何统计数据。</i></td></tr>'); // 调整 colspan
                return;
            }

            let hasTodayData = false;
            allStats.sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            allStats.forEach(entityStats => {
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;
                if (dailyData) {
                    hasTodayData = true;

                    // --- 计算并格式化平均 AI 响应时间 ---
                    let avgAiTimeStr = 'N/A';
                    if (dailyData.aiMessages > 0 && dailyData.totalAiResponseDuration > 0) {
                        const avgMs = dailyData.totalAiResponseDuration / dailyData.aiMessages;
                        avgAiTimeStr = `${(avgMs / 1000).toFixed(2)}s`; // 转换为秒，保留两位小数
                    }
                    // -----------------------------------

                    // **你需要修改这里的 HTML 结构以包含新的时间列**
                    const row = `
                        <tr>
                            <td>${entityStats.entityName || entityStats.entityId}</td>
                            <td>${dailyData.userMessages || 0} (${dailyData.userTokens || 0} tk)</td>
                            <td>${dailyData.aiMessages || 0} (${dailyData.aiTokens || 0} tk)</td>
                            <td>${dailyData.cumulativeTokens || 0}</td>
                            <td>${avgAiTimeStr}</td>  <%-- 新增：平均 AI 响应时间 --%>
                            <%-- <td>${todayString}</td> --%> <%-- 可能需要调整或移除日期列 --%>
                        </tr>
                    `;
                    tableBody.append(row);
                }
            });

            if (!hasTodayData) {
                 tableBody.append(`<tr><td colspan="6"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`); // 调整 colspan
            }

        } catch (error) {
            console.error(`[${extensionName}] Main: Error fetching or updating stats table:`, error);
            tableBody.empty().append('<tr><td colspan="6"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>'); // 调整 colspan
        }
    }

    // --- 事件处理 ---

    /**
     * 处理单条消息（用户或 AI），计算 Token/时长 并发送给 Worker 进行记录。
     * @param {object} message SillyTavern 的消息对象。
     * @param {boolean} isUser 标记消息是否由用户发送。
     */
    async function handleMessage(message, isUser) {
        if (!message || !currentEntityId) {
            return;
        }

        let tokenCount = 0;
        try {
            if (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0) {
                tokenCount = message.extra.token_count;
            } else if (message.mes) {
                tokenCount = await getTokenCountAsync(message.mes || '', 0);
            }
        } catch (err) {
            console.warn(`[${extensionName}] Main: Failed to get token count for message, estimating...`, err);
            tokenCount = Math.round((message.mes || '').length / 3.5);
        }

        // --- 新增：计算 AI 回复时长 ---
        let aiResponseDuration = null;
        if (!isUser && message.gen_finished && message.gen_started) {
            try {
                const end = new Date(message.gen_finished).getTime();
                const start = new Date(message.gen_started).getTime();
                if (!isNaN(end) && !isNaN(start) && end >= start) {
                    aiResponseDuration = end - start; // 时长，单位：毫秒
                } else {
                    console.warn(`[${extensionName}] Invalid timestamps for AI message: started=${message.gen_started}, finished=${message.gen_finished}`);
                }
            } catch (e) {
                console.error(`[${extensionName}] Error calculating AI duration:`, e);
            }
        }
        // -----------------------------

        const payload = {
            entityId: currentEntityId,
            entityName: currentEntityName,
            isUser: isUser,
            tokenCount: tokenCount,
            timestamp: message.send_date || Date.now(),
            // --- 将计算出的时长添加到 payload ---
            aiResponseDuration: aiResponseDuration,
        };
        sendMessageToWorker('processMessage', payload);
    }


    /**
     * 处理用户发送的消息 (MESSAGE_SENT 事件)
     */
    function onMessageSent(messageId) {
        const context = getContext();
        if (!context || !context.chat || !context.chat[messageId]) return;
        const message = context.chat[messageId];
        handleMessage(message, true); // 用户消息 isUser = true
    }

    /**
     * 处理聊天上下文变化 (CHAT_CHANGED 事件)
     */
    function onChatChanged(chatId) {
        const context = getContext();
        if (!context) {
            currentEntityId = null;
            currentEntityName = null;
            console.log(`[${extensionName}] Main: Chat context cleared.`);
            return;
        }

        let newEntityId = null;
        let newEntityName = null;

        if (context.groupId !== undefined && context.groupId !== null) {
            newEntityId = String(context.groupId);
            newEntityName = context.groups?.find(g => String(g.id) === newEntityId)?.name || newEntityId;
        } else if (context.characterId !== undefined && context.characterId !== null && context.characters && context.characters[context.characterId]) {
            newEntityId = context.characters[context.characterId].avatar;
            newEntityName = context.characters[context.characterId].name;
        }

        if (newEntityId !== currentEntityId) {
            currentEntityId = newEntityId;
            currentEntityName = newEntityName;
            console.log(`[${extensionName}] Main: Chat context changed. Current entity: ${currentEntityName || 'None'} (ID: ${currentEntityId || 'None'})`);
            pendingTokenConsumptionLog = false;
            lastCalculatedPromptTokens = 0;
            lastUsedApi = '';
            // 切换聊天时，也刷新一次表格显示新角色/群组的统计
            updateStatsTable();
        }
    }

    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`[${extensionName}] Main: Initializing extension...`);
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        // 初始化 IndexedDB
        try {
            await openDBMain();
            console.log(`[${extensionName}] Main: Initial DB connection/setup successful.`);
        } catch (error) {
            console.error(`[${extensionName}] Main: Critical - Failed initial DB open/setup:`, error);
        }

        // 注入设置 UI
        try {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            const targetContainer = $('#extensions_settings') || $('#extension_settings') || $('body');
            if (targetContainer.length) {
                targetContainer.append(settingsHtml);
                console.log(`[${extensionName}] Main: Settings UI injected.`);
                $('#day1-refresh-button').on('click', updateStatsTable);
                setTimeout(updateStatsTable, 500);
            } else {
                console.warn(`[${extensionName}] Main: Could not find suitable container (#extensions_settings) for settings UI.`);
            }
        } catch (error) {
            console.error(`[${extensionName}] Main: Error loading or injecting settings HTML: ${error}`);
        }

        // 初始化 Web Worker
        try {
            const workerPath = `${extensionFolderPath}/worker.js`;
            day1Worker = new Worker(workerPath);
            day1Worker.onmessage = (event) => { /* console.log(`[${extensionName}] Main: Received message from worker:`, event.data); */ };
            day1Worker.onerror = (error) => {
                console.error(`[${extensionName}] Main: Worker error reported:`, error.message, error);
            };
            console.log(`[${extensionName}] Main: Web Worker initialized successfully from path: ${workerPath}`);
        } catch (error) {
            console.error(`[${extensionName}] Main: Failed to initialize Web Worker from path "${extensionFolderPath}/worker.js":`, error);
            alert(`${extensionName} 插件未能成功加载后台处理程序，统计功能将不可用。`);
            day1Worker = null;
        }

        // --- 注册核心事件监听器 ---

        // 监听用户发送消息
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);

        // 监听聊天切换
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        // **新增：监听准备好发送给 API 的数据 (GENERATE_AFTER_DATA) - 用于预计算 Prompt Token**
        eventSource.on(event_types.GENERATE_AFTER_DATA, async (generateData) => {
            const context = getContext();
            const currentApi = generateData.type || context.mainApi || mainApi;
            let promptTokens = 0;

            if (generateData.dryRun || !currentEntityId) {
                return;
            }

            try {
                if (currentApi === 'openai' || generateData.is_openai) {
                    const messages = generateData.prompt;
                    if (Array.isArray(messages)) {
                        const tokenPromises = messages.map(message =>
                            getTokenCountAsync(message.content || '', 0)
                        );
                        const tokensPerMessage = await Promise.all(tokenPromises);
                        promptTokens = tokensPerMessage.reduce((sum, count) => sum + count, 0);
                    } else { console.warn(`[${extensionName}] OpenAI generateData.prompt 格式非预期数组:`, messages); }
                } else {
                    const promptString = generateData.prompt;
                    if (typeof promptString === 'string') {
                        const padding = typeof power_user === 'object' ? (power_user.token_padding || 0) : 0;
                        promptTokens = await getTokenCountAsync(promptString, padding);
                    } else { console.warn(`[${extensionName}] ${currentApi} generateData.prompt 格式非预期字符串:`, promptString); }
                }

                lastCalculatedPromptTokens = promptTokens;
                lastUsedApi = currentApi;
                pendingTokenConsumptionLog = true;
                 // console.log(`[${extensionName}] Stored pre-calculated Prompt Tokens: ${promptTokens} for entity ${currentEntityId}. Setting pending flag to true.`);

            } catch (error) {
                console.error(`[${extensionName}] 在 GENERATE_AFTER_DATA 中计算 Token 时出错:`, error);
                pendingTokenConsumptionLog = false;
            }
        });

        // **修改：合并的 MESSAGE_RECEIVED 监听器**
        // 处理 AI 回复消息的 Token/时长统计 和 确认 Prompt Token 消耗
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
            const context = getContext();

            // 1. 处理 AI 回复消息的 Token 和 时长 统计
            if (context && context.chat && context.chat[messageId]) {
                 const message = context.chat[messageId];
                 if (message && !message.is_user && !message.is_system) {
                     handleMessage(message, false); // isUser = false
                 }
            }

            // 2. 处理 Prompt Token 消耗确认
            if (pendingTokenConsumptionLog) {
                if (!currentEntityId) {
                     console.warn(`[${extensionName}] MESSAGE_RECEIVED: Pending consumption log is true, but currentEntityId is null. Cannot record prompt tokens.`);
                     pendingTokenConsumptionLog = false;
                     lastCalculatedPromptTokens = 0;
                     lastUsedApi = '';
                     return;
                }

                const payload = {
                    entityId: currentEntityId,
                    entityName: currentEntityName,
                    timestamp: Date.now(),
                    promptTokenCount: lastCalculatedPromptTokens,
                };
                sendMessageToWorker('recordPromptTokens', payload);

                pendingTokenConsumptionLog = false;
                lastCalculatedPromptTokens = 0;
                lastUsedApi = '';
            }
        });

        // **新增：监听生成停止 (GENERATION_STOPPED) - 用于取消未消耗的 Prompt Token**
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            if (pendingTokenConsumptionLog) {
                console.log(`[${extensionName}] GENERATION_STOPPED: Cancelling pending prompt token consumption log for entity ${currentEntityId}.`);
                pendingTokenConsumptionLog = false;
                lastCalculatedPromptTokens = 0;
                lastUsedApi = '';
            }
        });

        // 初始化时获取一次当前聊天上下文
        onChatChanged(getContext()?.chatId);

        console.log(`[${extensionName}] Main: Extension initialization complete. Event listeners registered.`);
    });

})();
