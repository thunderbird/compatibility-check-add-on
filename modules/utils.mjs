import { log } from "./log.mjs"

let jobs = [];

export const REBUILD_INTERVAL_IN_MINUTES = 24 * 60;

// A version compare function, taken from https://jsfiddle.net/vanowm/p7uvtbor/
export function compareVer(a, b) {
    function prep(t) {
        return ("" + t)
            //treat non-numerical characters as lower version
            //replacing them with a negative number based on charcode of first character
            .replace(/[^0-9\.]+/g, function (c) { return "." + ((c = c.replace(/[\W_]+/, "")) ? c.toLowerCase().charCodeAt(0) - 65536 : "") + "." })
            //remove trailing "." and "0" if followed by non-numerical characters (1.0.0b);
            .replace(/(?:\.0+)*(\.-[0-9]+)(\.[0-9]+)?\.*$/g, "$1$2")
            .split('.');
    }
    a = prep(a);
    b = prep(b);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
        //convert to integer the most efficient way
        a[i] = ~~a[i];
        b[i] = ~~b[i];
        if (a[i] > b[i])
            return 1;
        else if (a[i] < b[i])
            return -1;
    }
    return 0;
}

async function getInstalledExtensions() {
    let results = await messenger.management.getAll();
    return results.filter(addon =>
        addon.installType == "normal" &&
        addon.type == "extension" &&
        !addon.id.endsWith("mozilla.org")
    );
}

async function getReportData() {
    let url = "https://thunderbird.github.io/webext-reports/all.json"
    return fetch(url).then(r => r.json());
}

export function checkAddons(config = {}) {
    let action = config.action ?? "updateAddonData";
    let delay = config.delay ?? true;
    let info = config.info;
    jobs.push({ action, info, delay });
    if (jobs.length > 1) {
        return;
    }
    processNextJob();
}

// Check if the local copy of the reportData needs to be updated. This function
// is gaiting itself to ensure rate limits on the external servers.
async function processNextJob() {
    if (jobs.length == 0) {
        return;
    }

    let { action, info, delay } = jobs.at(0);
    if (delay) {
        await new Promise(r => window.setTimeout(r, 1000));
    }

    let { lastCheck } = await messenger.storage.local.get({ lastCheck: 0 });
    let { reportData } = await messenger.storage.local.get({ reportData: null });

    // Enforce rebuild, if no reportData or outdated database.
    if (
        !reportData ||
        !lastCheck ||
        lastCheck < Date.now() - (REBUILD_INTERVAL_IN_MINUTES * 60 * 1000)
    ) {
        action = "rebuild";
    }

    if (action == "rebuild") {
        log("Rebuilding ...");
        await messenger.browserAction.setBadgeText({ text: "…" });
        await messenger.browserAction.setBadgeBackgroundColor({ color: "blue" });
        await messenger.browserAction.disable();

        reportData = await getReportData();
        await messenger.storage.local.set({
            reportData,
            lastCheck: Date.now()
        });
        action = "updateAddonData";
    }

    log({ reportData });

    let { addonData } = await messenger.storage.local.get({ addonData: null });
    if (!addonData || action == "updateAddonData") {
        addonData = {};
        let installedAddons = await getInstalledExtensions();

        log({ installedAddons });

        for (let addon of installedAddons) {
            let data = reportData.addons.find(e => e.id == addon.id);
            if (!data) {
                addonData[addon.id] = {
                    id: addon.id,
                    name: addon.name,
                    isUnknown: true,
                    compat: [],
                }
            } else {
                addonData[addon.id] = data;
                addonData[addon.id].name = addon.name;
            }
            addonData[addon.id].enabled = addon.enabled;
        }
    }

    if (info) {
        log("Adjusting database to local add-on changes ...");
        switch (action) {
            case "enabled":
            case "disabled":
                if (addonData.hasOwnProperty(info.id)) {
                    addonData[info.id].enabled = info.enabled;
                }
                break;
            case "installed":
                {
                    let data = reportData.addons.find(e => e.id == info.id);
                    if (!data) {
                        addonData[info.id] = {
                            id: info.id,
                            name: info.name,
                            isUnknown: true,
                            compat: [],
                        }
                    } else {
                        addonData[info.id] = data;
                        addonData[info.id].name = info.name;
                    }
                    addonData[info.id].enabled = info.enabled;
                }
                break;
            case "uninstalled":
                delete addonData[info.id];
                break;
        }
    }

    await messenger.storage.local.set({ addonData });

    log({ addonData });

    // Update the browser action button.
    let webextensions = 0;
    let esrOnlyExperiments = 0;
    let releaseIncompatible = 0;
    let unknown = 0;

    for (let addon of Object.values(addonData)) {
        let release = addon.compat.find(e => e.type == "release");
        let isReleaseIncompatible = (!release || !release.extVersion);
        let isEsrOnlyExperiment = release && release.isExperiment;

        webextensions++;
        if (isReleaseIncompatible) {
            releaseIncompatible++;
        } else if (isEsrOnlyExperiment) {
            esrOnlyExperiments++;
        } else if (addon.isUnknown) {
            unknown++;
        }
    }

    // Alternatives are not "tracked". The user should look at the report and
    // then try out the alternative. Only compatible alternatives are listed.

    if (releaseIncompatible == 0 && esrOnlyExperiments == 0 && unknown == 0) {
        // Perfect.
        await messenger.browserAction.setBadgeText({ text: `✓` });
        await messenger.browserAction.setBadgeBackgroundColor({ color: "#27ae60" });
    } else if (releaseIncompatible == 0 && esrOnlyExperiments > 0 && unknown == 0) {
        // Jolo, some Experiments without release support.
        await messenger.browserAction.setBadgeText({ text: `✓` });
        await messenger.browserAction.setBadgeBackgroundColor({ color: "#ff6f00" });
    } else {
        // Bad, we have incompatible add-ons.
        await messenger.browserAction.setBadgeText({ text: `-${releaseIncompatible + unknown}` });
        await messenger.browserAction.setBadgeBackgroundColor({ color: "#c0392b" });
    }
    await messenger.browserAction.enable();

    jobs.shift();
    processNextJob();
}

export async function getBuildById(buildId) {
    const url = "https://buildhub.moz.tools/api/search";
    const query = {
        query: {
            term: {
                "build.id": buildId
            }
        }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(query)
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const data = await response.json();

        if (data.hits?.hits?.length > 0) {
            const build = data.hits.hits[0]._source;
            return {
                product: build.source.product,
                version: build.target.version,
            }
        }
    } catch (err) {
        console.error("Error fetching build info:", err);
        return null;
    }
}