window.GridIronDiff = (function () {
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

  function findDiffs(detail, overtime) {
    const diffs = [];
    const settings = [
      ['Scoring type', 'playerRankType'],
      ['Playoff teams', 'playoffTeamCount'],
      ['Playoff reseed', 'playoffReseed'],
      ['Regular-season weeks', 'matchupPeriodCount']
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

  function compare(detail, overtime) {
    const bothOk = !!(detail?.ok && overtime?.ok);
    const diffs = bothOk ? findDiffs(detail, overtime) : [];
    return {
      bothOk,
      matched: bothOk && diffs.length === 0,
      diffs,
      byKind: {
        Setting: diffs.filter((d) => d.kind === 'Setting'),
        Scoring: diffs.filter((d) => d.kind === 'Scoring'),
        Lineup: diffs.filter((d) => d.kind === 'Lineup')
      }
    };
  }

  return { fmt, fmtItem, findDiffs, compare };
})();
