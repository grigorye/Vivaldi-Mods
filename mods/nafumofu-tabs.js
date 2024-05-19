(async () => {
  "use strict";

  const config = {
    // デフォルト以外のワークスペースで自動タブスタックを使用する (true: 有効, false: 無効)
    // Use automatic tab stacking in non-default workspaces (true: enable, false: disable)
    workspace: true,

    // サブドメインごとにタブをスタックする (true: 有効, false: 無効)
    // Stack tabs by subdomain (true: enable, false: disable)
    subdomain: true,

    // タブスタック名を自動的に変更する (0: 無効, 1: ホスト名を使用, 2: ベースドメインから生成)
    // Automatically change tab stack names (0: disabled, 1: use hostname, 2: generated from base domain)
    stackname: 0,

    // 自動タブスタックの対象とするホストのルール (完全一致もしくは正規表現)
    // Rules for hosts to be included in the automatic tab stack (exact match or regular expression)
    includes: [],

    // 自動タブスタックから除外するホストのルール (完全一致もしくは正規表現)
    // Rules for hosts to be excluded from the automatic tab stack (exact match or regular expression)
    excludes: [
      // 'www.example.com',
      // /^(.+\.)?example\.net$/,
    ],
  };

  const addTabGroup = async (tabId, groupId) => {
    const tab = await chrome.tabs.get(tabId);
    const extData = JSON.parse(tab.vivExtData);
    extData.group = groupId;
    await chrome.tabs.update(tabId, { vivExtData: JSON.stringify(extData) });
  };

  const getUrlFragments = (url) => vivaldi.utilities.getUrlFragments(url);

  const getBaseDomain = (url) => {
    const urlFragments = getUrlFragments(url);
    return (
      urlFragments.host.match(`([^.]+\\.${urlFragments.tld})$`)?.[1] ||
      urlFragments.host
    );
  };

  const getHostname = (url) =>
    config.subdomain ? getUrlFragments(url).host : getBaseDomain(url);

  const matchHostRule = (url, rule) => {
    const hostname = getUrlFragments(url).host;
    return rule instanceof RegExp ? rule.test(hostname) : hostname === rule;
  };

  const getTabInfo = async (tabId) => {
    const tab = await chrome.tabs.get(tabId);

    if (tab.id !== -1) {
      tab.vivExtData = JSON.parse(tab.vivExtData);
      return tab;
    }
  };

  const getTabStore = async () => {
    const tabStore = {};

    const tabs = (await chrome.tabs.query({ currentWindow: true }))
      .filter((tab) => tab.id !== -1)
      .map((tab) =>
        Object.assign(tab, { vivExtData: JSON.parse(tab.vivExtData) })
      )
      .filter((tab) => !tab.pinned)
      .filter((tab) => !tab.vivExtData.panelId)
      .filter((tab) =>
        !config.includes.length
          ? true
          : config.includes.find((rule) => matchHostRule(tab.url, rule))
      )
      .filter(
        (tab) => !config.excludes.find((rule) => matchHostRule(tab.url, rule))
      );

    const workspaces = Object.groupBy(
      tabs,
      (tab) => tab.vivExtData.workspaceId
    );

    for (const [workspaceId, tabs] of Object.entries(workspaces)) {
      tabStore[workspaceId] = Object.groupBy(
        tabs,
        (tab) => tab.vivExtData.group
      );
    }
    return tabStore;
  };

  const getTabGroupMap = (tabStore) => {
    const tabGroupMap = {};

    for (const [workspaceId, groups] of Object.entries(tabStore)) {
      tabGroupMap[workspaceId] = {};

      for (const [groupId, tabs] of Object.entries(groups)) {
        const hostnames = Object.keys(
          Object.groupBy(tabs, (tab) => getHostname(tab.url))
        );

        if (hostnames.length === 1 && groupId && groupId !== "undefined") {
          tabGroupMap[workspaceId][hostnames[0]] ??= [];
          tabGroupMap[workspaceId][hostnames[0]].push(groupId);
        }
      }
    }
    return tabGroupMap;
  };

  const groupingTabs = async (targetTab) => {
    const tabStore = await getTabStore();
    const tabGroupMap = getTabGroupMap(tabStore);

    for (const [workspaceId, groups] of Object.entries(tabStore)) {
      if (!config.workspace && workspaceId !== "undefined") continue;
      if (String(targetTab.vivExtData.workspaceId) !== workspaceId) continue;

      const tabGroups = {};
      for (const tabs of Object.values(groups)) {
        for (const tab of tabs) {
          const hostname = getHostname(tab.url);
          tabGroupMap[workspaceId][hostname] ??= [crypto.randomUUID()];

          const groupId = tabGroupMap[workspaceId][hostname].sort()[0];
          tabGroups[groupId] ??= [];
          tabGroups[groupId].push(tab);
        }
      }

      for (const [groupId, tabs] of Object.entries(tabGroups)) {
        if (getHostname(targetTab.url) === getHostname(tabs[0].url)) {
          let tabIndex = (await getTabInfo(tabs[0].id)).index;

          if (config.stackname) {
            const stackNameMap = await vivaldi.prefs.get(
              "vivaldi.tabs.stacking.name_map"
            );
            let stackname;

            switch (config.stackname) {
              case 1:
                stackname = getHostname(targetTab.url);
                break;
              case 2:
                stackname = getBaseDomain(targetTab.url).split(".")[0];
                stackname =
                  stackname.charAt(0).toUpperCase() + stackname.slice(1);
                break;
            }
            await vivaldi.prefs.set({
              path: "vivaldi.tabs.stacking.name_map",
              value: Object.assign(stackNameMap, { [groupId]: stackname }),
            });
          }

          for (const tab of tabs) {
            if (tab.vivExtData.group !== groupId) {
              addTabGroup(tab.id, groupId);
            }
            chrome.tabs.move(tab.id, { index: tabIndex });
            tabIndex++;
          }
        }
      }
    }
  };

  chrome.webNavigation.onCommitted.addListener(async (details) => {
    const tab = await getTabInfo(details.tabId);

    if (
      tab &&
      !tab.pinned &&
      !tab.vivExtData.panelId &&
      details.frameType === "outermost_frame"
    ) {
      setTimeout(() => {
        groupingTabs(tab);
      }, 100);
    }
  });
})();
