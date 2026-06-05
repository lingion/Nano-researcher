function normalizeRegion(region) {
  return typeof region === 'string' ? region.trim() : '';
}

const DIRECT_CONTROLLED_MUNICIPALITY_TOKENS = {
  北京市: ['东城', '西城', '朝阳', '海淀', '丰台', '石景山', '通州', '顺义', '昌平', '大兴', '怀柔', '平谷', '密云', '延庆', '门头沟', '房山'],
  上海市: ['黄浦', '徐汇', '长宁', '静安', '普陀', '虹口', '杨浦', '闵行', '宝山', '嘉定', '浦东', '金山', '松江', '青浦', '奉贤', '崇明'],
  天津市: ['和平', '河东', '河西', '南开', '河北', '红桥', '东丽', '西青', '津南', '北辰', '武清', '宝坻', '滨海', '宁河', '静海', '蓟州'],
  重庆市: ['万州', '涪陵', '渝中', '大渡口', '江北', '沙坪坝', '九龙坡', '南岸', '北碚', '渝北', '巴南', '黔江', '长寿', '江津', '合川', '永川', '南川', '綦江', '大足', '璧山', '铜梁', '潼南', '荣昌', '开州', '梁平']
};

const KNOWN_DIRECT_PARENTS = {
  南山区: ['深圳市'],
  浦东新区: ['上海市'],
  深圳市: ['广东省'],
  杭州市: ['浙江省']
};

function getAdministrativeLevel(region) {
  if (region === '全国') return 0;
  if (/(省|自治区|特别行政区)$/.test(region)) return 1;
  if (/(市|州|地区|盟)$/.test(region)) return 2;
  if (/(区|县|旗)$/.test(region)) return 3;
  return null;
}

function isDirectControlledMunicipality(region) {
  return Object.hasOwn(DIRECT_CONTROLLED_MUNICIPALITY_TOKENS, region);
}

function municipalityMatchesDistrict(district, municipality) {
  const tokens = DIRECT_CONTROLLED_MUNICIPALITY_TOKENS[municipality] || [];
  return tokens.some((token) => district.includes(token));
}

function matchesKnownDirectParent(previousRegion, nextRegion) {
  const parents = KNOWN_DIRECT_PARENTS[previousRegion];
  return Array.isArray(parents) ? parents.includes(nextRegion) : null;
}

function isValidUpwardFallback(previousRegion, nextRegion) {
  if (nextRegion === '全国') return true;

  const previousLevel = getAdministrativeLevel(previousRegion);
  const nextLevel = getAdministrativeLevel(nextRegion);

  if (previousLevel == null || nextLevel == null) return true;
  if (nextLevel >= previousLevel) return false;

  if (previousLevel === 2 && isDirectControlledMunicipality(previousRegion)) {
    return false;
  }

  const knownParentMatch = matchesKnownDirectParent(previousRegion, nextRegion);
  if (knownParentMatch != null) {
    return knownParentMatch;
  }

  if (previousLevel === 3 && isDirectControlledMunicipality(nextRegion)) {
    return municipalityMatchesDistrict(previousRegion, nextRegion);
  }

  return true;
}

export function buildAdministrativeFallbackChain(regionPath, { includeNational = true } = {}) {
  const chain = [];
  const seen = new Set();

  for (const region of Array.isArray(regionPath) ? regionPath : []) {
    const normalized = normalizeRegion(region);
    if (!normalized || seen.has(normalized)) continue;

    const previous = chain.at(-1);
    if (previous && !isValidUpwardFallback(previous, normalized)) {
      break;
    }

    seen.add(normalized);
    chain.push(normalized);

    if (normalized === '全国') {
      break;
    }
  }

  if (includeNational && !seen.has('全国')) {
    chain.push('全国');
  }

  return chain;
}
