(async () => {
    'use strict';
    
    const config = {
        // タブスタックにベースドメインを使用する (true: 有効, false: 無効)
        // Use the base domain for tab stacks (true: enabled, false: disabled)
        base_domain: false,
        
        // タブスタックの名前を自動的に変更する (0: 無効, 1: ホスト名を使用, 2: ベースドメインから生成)
        // Automatically change the name of the tab stack (0: disabled, 1: use hostname, 2: generate from base domain)
        rename_stack: 2,
        
        // 自動タブスタックを許可するワークスペース (完全一致もしくは <default_workspace>)
        // * 未設定の場合はすべてのワークスペースで自動タブスタックを許可する
        // Workspaces that allow automatic tab stacking (exact match or <default_workspace>)
        // * If not set, automatic tab stacking is allowed in all workspaces
        allow_workspaces: [
            "<default_workspace>",
            // "Shopping",
        ],
        
        // 自動タブスタックを許可するドメイン (完全一致もしくは正規表現)
        // * 未設定の場合はすべてのドメインで自動タブスタックを許可する
        // Domains that allow automatic tab stacking (exact match or regular expression)
        // * If not set, automatic tab stacking is allowed for all domains
        allow_domains: [
            // "www.example.com",
            // /^(.+\.)?example\.net$/,
        ],
        
        // 自動タブスタックから除外するドメイン (完全一致もしくは正規表現)
        // Domains to exclude from automatic tab stacking (exact match or regular expression)
        block_domains: [
            // "www.example.com",
            // /^(.+\.)?example\.net$/,
        ],
    };
    
    const getUrlFragments = (url) => vivaldi.utilities.getUrlFragments(url);
    
    const extractBaseDomain = (url) => {
        const {hostForSecurityDisplay, tld} = getUrlFragments(url);
        return hostForSecurityDisplay.match(`([^.]+\\.${ tld })$`)?.[1] || hostForSecurityDisplay;
    };
    
    const extractHostname = (url) => {
        const {hostForSecurityDisplay} = getUrlFragments(url);
        return config.base_domain ? extractBaseDomain(url) : hostForSecurityDisplay;
    };
    
    const matchesHostRule = (url, rule) => {
        const {hostForSecurityDisplay} = getUrlFragments(url);
        return rule instanceof RegExp ? rule.test(hostForSecurityDisplay) : hostForSecurityDisplay === rule;
    };
    
    const getWorkspaceName = async (workspaceId) => {
        if (!workspaceId) {
            return '<default_workspace>';
        }
        const workspaceList = await vivaldi.prefs.get('vivaldi.workspaces.list');
        return workspaceList.value.find(item => item.id === workspaceId).name;
    };
    
    const filterTabs = (tabs) => {
        return tabs
            .filter(tab => tab.id !== -1 && tab.vivExtData)
            .map(tab => Object.assign(tab, { vivExtData: JSON.parse(tab.vivExtData) }))
            .filter(tab => !tab.pinned && !tab.vivExtData.panelId)
            .filter(tab => !config.allow_domains.length || config.allow_domains.find(rule => matchesHostRule(tab.url, rule)))
            .filter(tab => !config.block_domains.length || !config.block_domains.find(rule => matchesHostRule(tab.url, rule)));
    };
    
    const getTab = async (tabId) => {
        const tab = await chrome.tabs.get(tabId);
        return filterTabs([tab])[0];
    };
    
    const getTabs = async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        return filterTabs(tabs);
    };
    
    const getTabsByWorkspace = (tabs) => Object.groupBy(tabs, tab => tab.vivExtData.workspaceId);
    
    const getTabsByHost = (tabs) => Object.groupBy(tabs, tab => extractHostname(tab.url));
    
    const getTabIdsFromTabs = (tabs) => tabs.map(tab => tab.id);
    
    const findStackAnchorTab = (tabs, targetTab) => tabs.find(tab => tab.id !== targetTab.id && tab.vivExtData.group);
    
    const stackTabs = async (tabIds, target) => {
        await vivaldi.tabsPrivate.move({
            tabIds: tabIds,
            target: target,
            tweaks: ['do-not-reparent', 'create-new-group', 'target-is-tab'],
            debug: 'PageActions.createTabStack',
        });
    };
    
    const unstackTabs = async (tabIds, target) => {
        await vivaldi.tabsPrivate.move({
            tabIds: tabIds,
            target: target,
            tweaks: ['expand-related', 'untile', 'ungroup'],
            debug: 'PageActions.moveToIndex',
        });
    };
    
    const resolveTabStackName = (url) => {
        let name;
        
        switch (config.rename_stack) {
            case 1:
                name = extractHostname(url);
                break;
            case 2:
                name = extractBaseDomain(url).split('.')[0];
                name = name.charAt(0).toUpperCase() + name.slice(1);
                break;
        }
        return name;
    };
    
    const setTabStackName = async (tab, name) => {
        await vivaldi.tabsPrivate.setExtData({
            extId: tab.vivExtData.ext_id,
            groupTitle: name,
        });
    };
    
    const stackTabInWorkspace = async (targetTab, workspaceId) => {
        const targetHost = extractHostname(targetTab.url);
        
        if (targetHost !== 'devtools') {
            const tabs = await getTabs();
            const tabsByWorkspace = getTabsByWorkspace(tabs);
            const tabsByHost = getTabsByHost(tabsByWorkspace[workspaceId]);
            const tabIds = getTabIdsFromTabs(tabsByHost[targetHost]);
            const anchorTab = findStackAnchorTab(tabsByHost[targetHost], targetTab);
            const anchorTabId = anchorTab?.id || tabIds[0];
            const tabStackName = resolveTabStackName(targetTab.url);
            
            if (tabsByHost[targetHost].length >= 2) {
                if (anchorTab && anchorTab.vivExtData.group !== targetTab.vivExtData.group) {
                    const tabIndex = tabsByHost[targetHost].at(-1).index;
                    chrome.tabs.move(targetTab.id, { index: tabIndex });
                }
                
                await stackTabs(tabIds, anchorTabId);
                
                if (config.rename_stack) {
                    for (const tab of tabsByHost[targetHost]) {
                        setTabStackName(tab, tabStackName);
                    }
                }
            } else {
                if (targetTab.vivExtData.group) {
                    unstackTabs([targetTab.id], -1);
                }
            }
        }
    };
    
    chrome.webNavigation.onCommitted.addListener(async details => {
        if (details.tabId !== -1 && details.frameType === 'outermost_frame') {
            const targetTab = await getTab(details.tabId);
            
            if (targetTab) {
                const workspaceId = targetTab.vivExtData.workspaceId;
                const workspaceName = await getWorkspaceName(workspaceId);
                
                if (!config.allow_workspaces.length || config.allow_workspaces.includes(workspaceName)) {
                    stackTabInWorkspace(targetTab, workspaceId);
                }
            }
        }
    });
})();
