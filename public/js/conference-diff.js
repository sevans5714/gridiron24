window.GridIronDiff = (function () {
  // Target format for GridIron 24 conference brackets + Week 17 Bowl scoring.
  const PLAYOFF_TARGET = {
    matchupPeriodCount: 13,
    playoffTeamCount: 6,
    playoffReseed: true,
    playoffWeekCount: 4,
    firstPlayoffWeek: 14,
    finalScoringPeriod: 17
  };

  function fmt(n) {
    if (n == null || n === '') return '—';
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    return Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  function fmtItem(item) {
    if (!item) return '—';
    if (item.display) return String(item.display);
    return fmt(item.points);
  }

  function fmtBool(v) {
    if (v === true) return 'On';
    if (v === false) return 'Off';
    return '—';
  }

  function fmtSettingValue(key, value) {
    if (key === 'playoffReseed') return fmtBool(value);
    if (value == null || value === '') return '—';
    return String(value);
  }

  function mapByStat(items = []) {
    const map = new Map();
    for (const item of items) map.set(item.statId, item);
    return map;
  }

  function mapBySlot(lineup = []) {
    const map = new Map();
    for (const slot of lineup) map.set(slot.id, slot);
    return map;
  }

  function pointsNearlyEqual(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) < 1e-9;
  }

  function playoffRows(detail, overtime) {
    const fields = [
      {
        key: 'matchupPeriodCount',
        label: 'Regular-season weeks',
        hint: 'Should be 13 so playoffs start Week 14',
        target: PLAYOFF_TARGET.matchupPeriodCount
      },
      {
        key: 'playoffTeamCount',
        label: 'Playoff teams',
        hint: 'Top 6 per conference',
        target: PLAYOFF_TARGET.playoffTeamCount
      },
      {
        key: 'playoffReseed',
        label: 'Playoff reseed',
        hint: 'On after Wild Card',
        target: PLAYOFF_TARGET.playoffReseed
      },
      {
        key: 'firstPlayoffWeek',
        label: 'First playoff week',
        hint: 'Week 14 Wild Card',
        target: PLAYOFF_TARGET.firstPlayoffWeek
      },
      {
        key: 'playoffWeekCount',
        label: 'Playoff / Bowl weeks',
        hint: '14–17 (3 conference + Bowl scoring week)',
        target: PLAYOFF_TARGET.playoffWeekCount
      },
      {
        key: 'finalScoringPeriod',
        label: 'Final scoring week',
        hint: 'Week 17 GridIron Bowl',
        target: PLAYOFF_TARGET.finalScoringPeriod
      },
      {
        key: 'playoffMatchupPeriodLength',
        label: 'Playoff week length',
        hint: 'Usually 1 NFL week',
        target: 1
      },
      {
        key: 'playoffSeedingRule',
        label: 'Playoff seeding rule',
        hint: 'Should match across leagues',
        target: null
      }
    ];

    return fields.map((f) => {
      const dVal = detail?.[f.key];
      const oVal = overtime?.[f.key];
      const matched = dVal === oVal;
      const meetsTarget = f.target == null
        ? matched
        : dVal === f.target && oVal === f.target;
      return {
        kind: 'Playoff',
        key: f.key,
        label: f.label,
        hint: f.hint,
        detail: fmtSettingValue(f.key, dVal),
        overtime: fmtSettingValue(f.key, oVal),
        target: f.target == null ? 'Match each other' : fmtSettingValue(f.key, f.target),
        matched,
        meetsTarget,
        rawDetail: dVal,
        rawOvertime: oVal
      };
    });
  }

  function findDiffs(detail, overtime, { includePlayoff = true } = {}) {
    const diffs = [];
    const settings = [
      ['Scoring type', 'playerRankType']
    ];
    for (const [label, key] of settings) {
      const dVal = detail[key];
      const oVal = overtime[key];
      if (dVal !== oVal) {
        diffs.push({
          kind: 'Setting',
          label,
          detail: dVal == null ? '—' : String(dVal),
          overtime: oVal == null ? '—' : String(oVal)
        });
      }
    }

    if (includePlayoff) {
      for (const row of playoffRows(detail, overtime)) {
        if (!row.matched) {
          diffs.push({
            kind: 'Playoff',
            label: row.label,
            detail: row.detail,
            overtime: row.overtime,
            target: row.target
          });
        }
      }
    }

    const dScore = mapByStat(detail.scoringItems);
    const oScore = mapByStat(overtime.scoringItems);
    const ids = new Set([...dScore.keys(), ...oScore.keys()]);
    for (const id of [...ids].sort((a, b) => a - b)) {
      const d = dScore.get(id);
      const o = oScore.get(id);
      const dPts = d ? Number(d.points) : 0;
      const oPts = o ? Number(o.points) : 0;
      if (!pointsNearlyEqual(dPts, oPts)) {
        diffs.push({
          kind: 'Scoring',
          label: (d || o).label || `Stat ${id}`,
          detail: dPts === 0 ? 'off' : fmtItem(d),
          overtime: oPts === 0 ? 'off' : fmtItem(o),
          target: dPts === 0 ? 'off' : fmtItem(d),
          detailPoints: dPts,
          overtimePoints: oPts,
          overtimeNeeds: true,
          statId: id
        });
      }
    }

    const dLine = mapBySlot(detail.lineup);
    const oLine = mapBySlot(overtime.lineup);
    const slots = new Set([...dLine.keys(), ...oLine.keys()]);
    for (const id of [...slots].sort((a, b) => a - b)) {
      const d = dLine.get(id);
      const o = oLine.get(id);
      const dCount = d ? Number(d.count) : null;
      const oCount = o ? Number(o.count) : null;
      if (dCount !== oCount) {
        diffs.push({
          kind: 'Lineup',
          label: (d || o).label || `Slot ${id}`,
          detail: d ? String(dCount) : 'missing',
          overtime: o ? String(oCount) : 'missing',
          target: d ? String(dCount) : '0'
        });
      }
    }

    return diffs;
  }

  function byKind(diffs) {
    return {
      Setting: diffs.filter((d) => d.kind === 'Setting'),
      Playoff: diffs.filter((d) => d.kind === 'Playoff'),
      Scoring: diffs.filter((d) => d.kind === 'Scoring'),
      Lineup: diffs.filter((d) => d.kind === 'Lineup')
    };
  }

  function compare(detail, overtime, options = {}) {
    const bothOk = !!(detail?.ok && overtime?.ok);
    const playoff = bothOk && options.includePlayoff !== false ? playoffRows(detail, overtime) : [];
    const diffs = bothOk ? findDiffs(detail, overtime, options) : [];
    const playoffMatched = playoff.length > 0 && playoff.every((r) => r.matched);
    const playoffOnTarget = playoff.length > 0 && playoff.every((r) => r.meetsTarget);
    return {
      bothOk,
      matched: bothOk && diffs.length === 0,
      playoffMatched,
      playoffOnTarget,
      playoff,
      playoffTarget: PLAYOFF_TARGET,
      diffs,
      byKind: byKind(diffs)
    };
  }

  /** Scoring type, categories, and lineup only — used for AAA vs GridIron 24. */
  function compareScoring(primary, peer) {
    return compare(primary, peer, { includePlayoff: false });
  }

  return { fmt, fmtItem, findDiffs, compare, compareScoring, playoffRows, PLAYOFF_TARGET };
})();
