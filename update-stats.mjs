#!/usr/bin/env node
/**
 * Fetches REAL public GitHub data for USERNAME via the GitHub GraphQL API and
 * rewrites stats.svg, langs.svg, trophies.svg and the Featured Projects table
 * in README.md with that data. No numbers are ever hard-coded — everything
 * here comes from the API response at run time.
 *
 * Requires: GITHUB_TOKEN (provided automatically in Actions), USERNAME env var.
 */
import fs from "node:fs/promises";

const USERNAME = process.env.TARGET_USERNAME || "Murali-Hacker-Efx";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const QUERY = `
query($login: String!) {
  user(login: $login) {
    createdAt
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes {
        name
        url
        description
        stargazerCount
        primaryLanguage { name color }
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      contributionCalendar { totalContributions }
    }
  }
}`;

async function fetchUser() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-updater",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("GitHub API error: " + JSON.stringify(json.errors));
  }
  if (!json.data || !json.data.user) {
    throw new Error(`User ${USERNAME} not found or not public.`);
  }
  return json.data.user;
}

function rankLetter(value, thresholds) {
  // thresholds = [ [minValue, letter], ... ] sorted descending by minValue
  for (const [min, letter] of thresholds) {
    if (value >= min) return letter;
  }
  return thresholds[thresholds.length - 1][1];
}

function fillTemplate(str, map) {
  return str.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => (key in map ? map[key] : m));
}

async function main() {
  const user = await fetchUser();

  const repos = user.repositories.nodes;
  const repoCount = user.repositories.totalCount;
  const followers = user.followers.totalCount;
  const totalStars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const totalContributions = user.contributionsCollection.contributionCalendar.totalContributions;
  const totalCommits = user.contributionsCollection.totalCommitContributions;
  const joined = new Date(user.createdAt);
  const yearsActive = Math.max(1, Math.floor((Date.now() - joined.getTime()) / (365.25 * 24 * 3600 * 1000)));

  // ---- aggregate language bytes across all public repos ----
  const langBytes = new Map(); // name -> {size, color}
  for (const r of repos) {
    for (const edge of r.languages.edges) {
      const name = edge.node.name;
      const prev = langBytes.get(name) || { size: 0, color: edge.node.color || "#8a8a8a" };
      prev.size += edge.size;
      langBytes.set(name, prev);
    }
  }
  const totalBytes = [...langBytes.values()].reduce((s, v) => s + v.size, 0) || 1;
  const topLangs = [...langBytes.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6);

  // ---- simple heuristic rank score (not an official GitHub metric) ----
  const score = totalStars * 3 + totalContributions * 0.5 + repoCount * 4 + followers * 3;
  const maxExpected = 3000; // soft ceiling for the ring fill
  const pct = Math.min(1, score / maxExpected);
  const rank = rankLetter(score, [
    [1500, "S"],
    [700, "A"],
    [250, "B"],
    [50, "C"],
    [0, "D"],
  ]);

  // ================= stats.svg =================
  let statsSvg = await fs.readFile("stats.svg", "utf8");
  const ringR = 46;
  const circumference = 2 * Math.PI * ringR;
  statsSvg = fillTemplate(statsSvg, {
    USERNAME,
    REPOS: String(repoCount),
    CONTRIB: String(totalContributions),
    STARS: String(totalStars),
    FOLLOWERS: String(followers),
    RANK: rank,
    RING_OFFSET: (circumference * (1 - pct)).toFixed(1),
  });
  await fs.writeFile("stats.svg", statsSvg);

  // ================= langs.svg =================
  let langsSvg = await fs.readFile("langs.svg", "utf8");
  const langMap = {};
  for (let i = 0; i < 6; i++) {
    if (topLangs[i]) {
      const [name, info] = topLangs[i];
      const pctLang = (info.size / totalBytes) * 100;
      langMap[`LANG${i}_NAME`] = name;
      langMap[`LANG${i}_COLOR`] = info.color;
      langMap[`LANG${i}_PCT`] = pctLang.toFixed(1);
      langMap[`LANG${i}_WIDTH`] = (447 * (pctLang / 100)).toFixed(1);
    } else {
      langMap[`LANG${i}_NAME`] = "";
      langMap[`LANG${i}_COLOR`] = "#00000000";
      langMap[`LANG${i}_PCT`] = "0";
      langMap[`LANG${i}_WIDTH`] = "0";
    }
  }
  langsSvg = fillTemplate(langsSvg, langMap);
  await fs.writeFile("langs.svg", langsSvg);

  // ================= trophies.svg =================
  let trophiesSvg = await fs.readFile("trophies.svg", "utf8");
  const trophyRanks = [
    rankLetter(repoCount, [[30, "S"], [15, "A"], [5, "B"], [0, "C"]]),
    rankLetter(totalCommits, [[1000, "S"], [500, "A"], [100, "B"], [0, "C"]]),
    rankLetter(totalStars, [[100, "S"], [30, "A"], [5, "B"], [0, "C"]]),
    rankLetter(followers, [[100, "S"], [30, "A"], [5, "B"], [0, "C"]]),
    rankLetter(totalContributions, [[1500, "S"], [700, "A"], [200, "B"], [0, "C"]]),
    rankLetter(yearsActive, [[4, "S"], [2, "A"], [1, "B"], [0, "C"]]),
  ];
  const trophyMap = {};
  trophyRanks.forEach((r, i) => (trophyMap[`TROPHY${i}_RANK`] = r));
  trophiesSvg = fillTemplate(trophiesSvg, trophyMap);
  await fs.writeFile("trophies.svg", trophiesSvg);

  // ================= README project table =================
  const topRepos = [...repos]
    .filter((r) => !r.description || true)
    .sort((a, b) => b.stargazerCount - a.stargazerCount)
    .slice(0, 5);

  let table;
  if (topRepos.length === 0) {
    table = "_No public repositories found yet — this section will populate automatically once you publish some._";
  } else {
    const rows = topRepos
      .map(
        (r) =>
          `| [${r.name}](${r.url}) | ${r.description ? r.description.replace(/\|/g, "-") : "—"} | ${
            r.primaryLanguage ? r.primaryLanguage.name : "—"
          } | ${r.stargazerCount} |`
      )
      .join("\n");
    table = `| Project | Description | Language | Stars |\n|---|---|---|---|\n${rows}`;
  }

  let readme = await fs.readFile("README.md", "utf8");
  readme = readme.replace(
    /<!--PROJECTS:START-->[\s\S]*?<!--PROJECTS:END-->/,
    `<!--PROJECTS:START-->\n${table}\n<!--PROJECTS:END-->`
  );
  await fs.writeFile("README.md", readme);

  console.log("Updated stats for", USERNAME, {
    repoCount,
    followers,
    totalStars,
    totalContributions,
    rank,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
