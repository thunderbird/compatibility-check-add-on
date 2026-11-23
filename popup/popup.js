import { log } from "../modules/log.mjs"
import { compareVer } from "../modules/utils.mjs";

const BEST_ICON_SIZE = 32;

const SORT_DISABLED = 16;
const SORT_RELEASE_COMPATIBLE_CERTAIN = 8;
const SORT_RELEASE_COMPATIBLE_UNCERTAIN = 4;
const SORT_NEXT_ESR_COMPATIBLE = 2;
const SORT_ESR_COMPATIBLE = 1;

function findBestSize(icons) {
  if (!icons) {
    return "https://addons.thunderbird.net/static/img/addon-icons/default-32.png";
  }

  const allIcons = Object
    .entries(icons)
    .map(e => ({ size: e[0], url: e[1] }));
  const bestIcon = allIcons.reduce(
    (acc, cur) => Math.abs(BEST_ICON_SIZE - cur.size) < Math.abs(BEST_ICON_SIZE - acc.size) ? cur : acc,
    { size: 0, url: allIcons[0].url }
  );
  return bestIcon.url;
}

function getDataForAddonId(id, reportData) {
  if (!reportData) {
    return null;
  }
  let data = reportData.addons.find(e => e.id == id);
  if (!data) {
    return null
  }
  return data;
}

// An alternative which is a built-in feature (no id) or a Release-compatible
// add-on which is not an Experiment.
function isPureWebExtensionAlternative(alt, reportData) {
  if (alt.name && alt.link && !alt.id) {
    return true;
  }
  let release = getDataForAddonId(alt.id, reportData)?.compat.find(e => e.type == "release");
  return !!(release?.extVersion && !release.isExperiment);
}

function buildAlternativeCell(basicNameCell, alternative, addon, labelKey, linkOnNewLine = false, substitutions = []) {
  let target = alternative.id && alternative.link
    ? `<a href="${alternative.link}">${alternative.name}</a>`
    : alternative.link
      ? `<a href="https://extension-finder.thunderbird.net/?id=${encodeURIComponent(addon.id)}&q=${encodeURIComponent(addon.name)}">${alternative.name}</a>`
      : `${alternative.name}`;
  return `<div style="display: flex; flex-direction: column;">
                  ${basicNameCell}
                  <span class="annotation">${browser.i18n.getMessage(labelKey, substitutions)}:${linkOnNewLine ? "<br>" : " "}${target}</span>
                </div>`;
}

async function onLoad() {
  // Open links in a Thunderbird tab instead of the external browser.
  document.addEventListener("click", event => {
    let link = event.target.closest("a[href^='http']");
    if (!link) {
      return;
    }
    event.preventDefault();
    browser.tabs.create({ url: link.href });
    window.close();
  });

  // Localize.
  for (let element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = browser.i18n.getMessage(element.dataset.i18n);
  }

  let { reportData } = await messenger.storage.local.get({ reportData: null });

  let lastUpdate = new Date(reportData.generated);
  document.getElementById("lastUpdate").textContent = lastUpdate.toLocaleString();

  let { addonData } = await messenger.storage.local.get({ addonData: null });
  log({ addonData });
  if (!addonData) {
    let infoElement = document.getElementById("info");
    infoElement.style.display = "block";
    return;
  }

  let tableElement = document.getElementById("compatibilityTable");
  let esrOnlyExperiments = 0;
  let releaseIncompatible = 0;
  let webextensions = 0;
  let unknown = 0;

  let columns = new Map();
  let rows = [];
  let html = [];

  const TYPE_MAP = {
    "release": "Release",
    "next-esr": "next&nbsp;ESR",
    "current-esr": "ESR"
  }

  for (let addon of Object.values(addonData)) {
    webextensions++;

    let sortOrder = 0;
    for (let type of Object.keys(TYPE_MAP)) {
      let compatEntry = addon.compat.find(e => e.type == type);
      if (compatEntry?.extVersion) {
        if (type == "current-esr") {
          sortOrder += SORT_ESR_COMPATIBLE;
        }
        if (type == "next-esr") {
          sortOrder += SORT_NEXT_ESR_COMPATIBLE;
        }
        if (type == "release") {
          if (!compatEntry.isExperiment) {
            sortOrder += SORT_RELEASE_COMPATIBLE_CERTAIN;
          } else {
            sortOrder += SORT_RELEASE_COMPATIBLE_UNCERTAIN;
          }
        }
      }
      if (!addon.enabled) {
        sortOrder += SORT_DISABLED;
      }
    }

    let release = addon.compat.find(e => e.type == "release");
    let isReleaseIncompatible = (!release || !release.extVersion);
    let isEsrOnlyExperiment = release && release.isExperiment;

    if (isReleaseIncompatible) {
      releaseIncompatible++;
    }

    let basicNameCell = `<span class="name-span" data-i18n-disabled="${browser.i18n.getMessage("disabled")}">${addon.name}</span>`;
    let nameCell = basicNameCell;
    if (isEsrOnlyExperiment) {
      esrOnlyExperiments++;
      nameCell = `<div style="display: flex; flex-direction: column;">
                ${basicNameCell}
                <span class="annotation">Experiment/Legacy Add-on (${browser.i18n.getMessage("subtext_may_break_on_release")})</span>
              </div>`
    }

    if (isReleaseIncompatible && addon.alternatives?.length > 0) {
      // Filter for alternatives compatible with Release.
      let alternative = addon.alternatives.find(alt => {
        if (alt.name && alt.link && !alt.id) {
          // This is a now a built-in feature.
          return true;
        }

        let data = getDataForAddonId(alt.id, reportData);
        return (data && data.compat.find(e => e.type == "release")?.extVersion);
      })

      if (alternative?.name) {
        nameCell = buildAlternativeCell(basicNameCell, alternative, addon, "subtext_alternative");
      }
    }

    if (isEsrOnlyExperiment && addon.alternatives?.length > 0) {
      // Replaces the Experiment note, if there is a pure WebExtension alternative.
      let alternative = addon.alternatives.find(alt => alt.name && isPureWebExtensionAlternative(alt, reportData));
      if (alternative) {
        let reason = browser.i18n.getMessage("subtext_may_break_on_release");
        nameCell = buildAlternativeCell(basicNameCell, alternative, addon, "subtext_experiment_with_alternative", true, [reason]);
      }
    }

    if (addon.isUnknown) {
      unknown++;
      nameCell = `<div style="display: flex; flex-direction: column;">
      ${basicNameCell}
      <span class="annotation">${browser.i18n.getMessage("subtext_not_listed")}</span>
    </div>`
    }

    let cells = new Map();
    cells.set("icon", `<td><img width="${BEST_ICON_SIZE}" src="${findBestSize(addon.icons)}"></td>`);
    cells.set("name", `<td>${nameCell}</td>`);

    addon.compat.forEach(e => {
      const compatible = !!e.extVersion;
      const classes = [];
      if (e.experiment) classes.push("experiment");
      if (compatible) {
        classes.push("compatible");
      } else {
        classes.push("incompatible");
      }

      let title = `compatible version: ${compatible ? `v${e.extVersion}` : "none"}`
      let value = compatible ? e.type == "release" && isEsrOnlyExperiment ? "(✔)" : "✔" : "❌"
      cells.set(
        e.type,
        `<td title="${title}" class="${classes.join(" ")}"><span>${value}</span></td>`
      );
      // Keep track of available columns.
      columns.set(e.type, e.appVersion);
    });
    rows.push({ cells, addon, compatibilityRating: sortOrder });
  }

  html.push("<thead>");
  html.push("<tr class='header'>")
  html.push(`<th colspan=2>${browser.i18n.getMessage("table_header")}</th>`);
  for (let type of ["current-esr", "next-esr", "release"]) {
    if (columns.has(type)) html.push(`<th>TB&nbsp;${columns.get(type)} (${TYPE_MAP[type]})</th>`)
  }
  html.push("</tr>")
  html.push("</thead>");
  html.push("<tbody>");

  rows.sort((a, b) => a.compatibilityRating - b.compatibilityRating);
  for (let { cells, addon } of rows) {
    html.push(`<tr data-enabled="${!!addon.enabled}">`);
    html.push(cells.get("icon"));
    html.push(cells.get("name"));
    for (let type of ["current-esr", "next-esr", "release"]) {
      if (columns.has(type)) {
        if (cells.has(type)) {
          html.push(cells.get(type))
        } else {
          html.push(
            `<td title="${browser.i18n.getMessage("subtext_not_listed")}" class="unknown">❓</td>`
          )
        }
      }
    }
    html.push("</tr>")
  }
  html.push("</tbody>");

  tableElement.insertAdjacentHTML("afterbegin", html.join("\n"));
  tableElement.style.display = "block";

  log("results", { webextensions, esrOnlyExperiments, releaseIncompatible, unknown });

  let { buildIsESR } = await browser.storage.session.get({ buildIsESR: false });
  let { majorLocalVersion } = await browser.storage.session.get({ majorLocalVersion: 0 });

  let majorReleaseVersion = parseInt(columns.get("release"), 10);
  let localVersionIsRelease = !buildIsESR && (majorLocalVersion >= majorReleaseVersion);
   
  const box = document.querySelector('#status-box');
  if (
    webextensions > 0 &&
    !releaseIncompatible &&
    !esrOnlyExperiments &&
    !localVersionIsRelease
  ) { // only pure WebExtensions
    box.dataset.status = 'compatible';
    box.textContent = `${browser.i18n.getMessage("suggestion_upgrade_to_release")}`
  } else if (
    webextensions > 0 &&
    !releaseIncompatible &&
    esrOnlyExperiments > 0
  ) { // some ESR-only-Experiments
    box.dataset.status = 'warning';
    box.textContent = localVersionIsRelease
      ? browser.i18n.getMessage("suggestion_move_back_to_esr_unsupported_experiments")
      : browser.i18n.getMessage("suggestion_stay_on_esr_unsupported_experiments")
  } else if (
    webextensions > 0 &&
    releaseIncompatible > 0
  ) { // some incompatible
    box.dataset.status = 'incompatible';
    box.textContent = localVersionIsRelease
      ? browser.i18n.getMessage("suggestion_move_back_to_esr_incompatible")
      : browser.i18n.getMessage("suggestion_stay_on_esr_incompatible")
  }
}

await onLoad();