const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = __dirname;
const SOURCE_CSV = String.raw`C:\Users\ASUS\Downloads\BLR_Restaurants_Clean.csv`;
const OUTPUT_FILE = path.join(WORKSPACE, "restaurants-data.js");

const AREA_ALIASES = {
  "btm layout": "BTM Layout",
  "bannerghatta road": "Bannerghatta Road",
  "brigade road": "Brigade Road",
  "indiranagar": "Indiranagar",
  "malleshwaram": "Malleshwaram",
  "electronic city": "Electronic City",
  "banashankari": "Banashankari",
  "kalyan nagar": "Kalyan Nagar",
  "bellandur": "Bellandur",
  "marathahalli": "Marathahalli",
  "basavanagudi": "Basavanagudi",
  "rajajinagar": "Rajajinagar",
  "lavelle road": "Lavelle Road",
  "jayanagar": "Jayanagar",
  "frazer town": "Frazer Town",
  "brookefield": "Brookefield",
  "old airport road": "Old Airport Road",
  "jp nagar": "JP Nagar",
  "kammanahalli": "Kammanahalli",
  "whitefield": "Whitefield",
  "church street": "Church Street",
  "new bel road": "New BEL Road",
  "sarjapur road": "Sarjapur Road",
  "mg road": "MG Road",
  "residency road": "Residency Road",
  hsr: "HSR Layout",
};

const ADDRESS_AREA_HINTS = [
  ["Church Street", "church street"],
  ["Bannerghatta Road", "bannerghatta"],
  ["HSR Layout", "hsr"],
  ["Indiranagar", "indiranagar"],
  ["Whitefield", "whitefield"],
  ["Koramangala", "koramangala"],
  ["Lavelle Road", "lavelle"],
  ["Brigade Road", "brigade"],
  ["Old Airport Road", "airport road"],
  ["Sarjapur Road", "sarjapur"],
  ["Electronic City", "electronic city"],
  ["MG Road", "mahatma gandhi rd"],
  ["MG Road", "mg road"],
  ["JP Nagar", "j p nagar"],
  ["JP Nagar", "jp nagar"],
];

const MOJIBAKE_MARKERS = ["Ã", "Â", "â", "\uFFFD"];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      if (row.some((item) => item !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows;
  return body.map((items) => {
    const record = {};
    header.forEach((column, index) => {
      record[column] = items[index] ?? "";
    });
    return record;
  });
}

function repairText(value) {
  if (value == null) return "";
  const text = String(value).replace(/\ufeff/g, "").replace(/\u00a0/g, " ").trim();
  if (!text) return "";
  const candidates = [text];
  if (MOJIBAKE_MARKERS.some((marker) => text.includes(marker))) {
    try {
      candidates.push(Buffer.from(text, "latin1").toString("utf8"));
    } catch {}
  }
  return candidates
    .map((candidate) => candidate.replace(/\s+/g, " ").trim().replace(/^[,\s]+|[,\s]+$/g, ""))
    .sort((left, right) => weirdScore(left) - weirdScore(right) || right.length - left.length)[0];
}

function weirdScore(text) {
  return MOJIBAKE_MARKERS.reduce((score, marker) => score + (text.match(new RegExp(marker, "g")) || []).length, 0);
}

function parseFloatSafe(value) {
  const text = repairText(value).replace(/,/g, "");
  if (!text) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function parseIntSafe(value) {
  const number = parseFloatSafe(value);
  return number == null ? 0 : Math.round(number);
}

function clamp(number, lower, upper) {
  return Math.max(lower, Math.min(number, upper));
}

function slugify(value) {
  return repairText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "restaurant";
}

function normalizeArea(area, address) {
  const source = repairText(area);
  const addressText = repairText(address).toLowerCase();

  if (source.toLowerCase().startsWith("koramangala")) return { area: "Koramangala", microArea: source };
  if (source.toLowerCase() === "hsr") return { area: "HSR Layout", microArea: "HSR" };

  const alias = AREA_ALIASES[source.toLowerCase()];
  if (alias) return { area: alias, microArea: source };

  if (source) {
    const titled = source
      .split(/\s+/)
      .map((word) => (["JP", "MG", "HSR", "BEL"].includes(word.toUpperCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
      .join(" ");
    return { area: titled, microArea: source };
  }

  for (const [label, needle] of ADDRESS_AREA_HINTS) {
    if (addressText.includes(needle)) return { area: label, microArea: "" };
  }

  return { area: "Unknown Area", microArea: "" };
}

function splitCuisines(value) {
  return repairText(value)
    .split(",")
    .map((item) => item.replace(/\s+/g, " ").trim().replace(/^-+|-+$/g, ""))
    .filter(Boolean);
}

function normalizeBool(value) {
  const text = repairText(value).toLowerCase();
  if (["yes", "true", "1"].includes(text)) return true;
  if (["no", "false", "0"].includes(text)) return false;
  return null;
}

function categoryFromType(restaurantType, cuisine) {
  const text = `${restaurantType} ${cuisine}`.toLowerCase();
  if (/(dessert|ice cream|sweet|mithai|waffle)/.test(text)) return "dessert";
  if (/(cafe|coffee|bakery|beverage)/.test(text)) return "cafe";
  if (/(bar|pub|brew|lounge|microbrew)/.test(text)) return "bar";
  return "restaurant";
}

function firstAddressLine(value) {
  const text = repairText(value);
  return text ? text.split(",")[0].trim() : "";
}

function buildExplanation(restaurant) {
  const { rating, adjustedRating, reviewCount, hypeScore, underratedScore, reliabilityScore, tag } = restaurant;
  if (tag === "overhyped") {
    if (reliabilityScore >= 0.35) {
      return `Highly visible with ${reviewCount.toLocaleString("en-IN")} reviews, but the adjusted quality settles near ${adjustedRating.toFixed(1)}.`;
    }
    return `Visibility is outrunning quality here, so the popularity looks stronger than the food signal.`;
  }
  if (tag === "hidden-gem") {
    if (reliabilityScore >= 0.28) {
      return `Exceptional adjusted quality at ${adjustedRating.toFixed(1)} despite lower visibility makes this a strong hidden gem.`;
    }
    return `Strong quality with limited mainstream attention gives this real discovery potential.`;
  }
  if (reliabilityScore >= 0.5) {
    return `The adjusted score holds at ${adjustedRating.toFixed(1)} across ${reviewCount.toLocaleString("en-IN")} reviews, so this reads as dependable.`;
  }
  if (underratedScore >= 0.1) {
    return "Quality is quietly doing the work here even without oversized attention.";
  }
  if (hypeScore >= 0.1) {
    return `Mainstream enough to be visible, but the quality signal still holds in a reasonable range.`;
  }
  return "Balanced visibility, quality, and review confidence keep this in the worth-it zone.";
}

function deriveMoods(restaurant) {
  const moods = [];
  if (restaurant.hypeScore <= 0.18 && restaurant.reliabilityScore >= 0.3) moods.push("chill");
  if (restaurant.priceRange && restaurant.priceRange <= 500 && restaurant.underratedScore >= 0.12) moods.push("budget");
  if (restaurant.adjustedRating >= 4.2 && restaurant.reliabilityScore >= 0.35 && restaurant.priceRange >= 900) moods.push("fancy");
  if (restaurant.underratedScore >= 0.16 && restaurant.popularity <= 0.42) moods.push("experimental");
  if (restaurant.popularity >= 0.55 || restaurant.hypeScore >= 0.12) moods.push("indulgent");
  return moods;
}

function computeBounds(points) {
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const south = Math.min(...lats) - 0.04;
  const north = Math.max(...lats) + 0.04;
  const west = Math.min(...lngs) - 0.04;
  const east = Math.max(...lngs) + 0.04;
  return {
    center: [Number(((west + east) / 2).toFixed(6)), Number(((south + north) / 2).toFixed(6))],
    southWest: [Number(west.toFixed(6)), Number(south.toFixed(6))],
    northEast: [Number(east.toFixed(6)), Number(north.toFixed(6))],
  };
}

function percentile(values, ratio) {
  if (!values.length) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[index] || 1;
}

function main() {
  const csvText = fs.readFileSync(SOURCE_CSV, "utf8");
  const records = parseCsv(csvText);

  const rows = records
    .map((record, index) => {
      const name = repairText(record["Restaurant Name"]);
      if (!name) return null;
      const fullAddress = repairText(record["Full Address"]);
      const { area, microArea } = normalizeArea(record["Area"], fullAddress);
      const lat = parseFloatSafe(record["Latitude"]);
      const lng = parseFloatSafe(record["Longitude"]);
      const preciseCoordinates = Number.isFinite(lat) && Number.isFinite(lng);
      const cuisines = splitCuisines(record["Cuisines"]);
      const priceRange = parseIntSafe(record["Avg Cost (Two People ₹)"]);
      const rating = clamp(parseFloatSafe(record["Rating"]) || 0, 0, 5);
      const reviewCount = parseIntSafe(record["No. of Ratings"]);
      return {
        id: `blr-${index + 1}`,
        name,
        slug: `${slugify(name)}-${index + 1}`,
        area,
        microArea: repairText(microArea),
        lat,
        lng,
        preciseCoordinates,
        coordinateSource: preciseCoordinates ? "dataset" : "missing",
        cuisine: cuisines.join(", "),
        cuisines,
        priceRange,
        rating,
        reviewCount,
        restaurantType: repairText(record["Restaurant Type"]),
        ratingSource: repairText(record["Rating Source"]),
        zomatoRating: parseFloatSafe(record["Zomato Rating"]),
        zomatoReviewCount: parseIntSafe(record["Zomato No. of Ratings"]),
        tripadvisorRating: parseFloatSafe(record["TripAdvisor Rating"]),
        tripadvisorReviewCount: parseIntSafe(record["TripAdvisor No. of Reviews"]),
        swiggyRating: parseFloatSafe(record["Swiggy Rating"]),
        swiggyReviewCount: parseIntSafe(record["Swiggy No. of Ratings"]),
        phone: repairText(record["Phone"]),
        fullAddress,
        localAddress: firstAddressLine(fullAddress),
        description: repairText(record["Description"]),
        dietaryRestrictions: repairText(record["Dietary Restrictions"]),
        features: repairText(record["Features"]),
        mealType: repairText(record["Meal Type"]),
        timings: repairText(record["Meal Type"]),
        onlineOrder: normalizeBool(record["Online Order"]),
        tableBooking: normalizeBool(record["Table Booking"]),
        deliveryTimeMins: parseIntSafe(record["Delivery Time (Mins)"]),
        dataSources: repairText(record["Data Sources"]),
      };
    })
    .filter(Boolean);

  const areaPoints = new Map();
  for (const row of rows) {
    if (!row.preciseCoordinates) continue;
    if (!areaPoints.has(row.area)) areaPoints.set(row.area, []);
    areaPoints.get(row.area).push({ lat: row.lat, lng: row.lng });
  }

  const centroids = new Map();
  for (const [area, points] of areaPoints.entries()) {
    centroids.set(area, {
      lat: Number((points.reduce((sum, point) => sum + point.lat, 0) / points.length).toFixed(6)),
      lng: Number((points.reduce((sum, point) => sum + point.lng, 0) / points.length).toFixed(6)),
    });
  }

  for (const row of rows) {
    if (row.preciseCoordinates) continue;
    const centroid = centroids.get(row.area);
    if (!centroid) continue;
    row.lat = centroid.lat;
    row.lng = centroid.lng;
    row.coordinateSource = "area-centroid";
  }

  const maxReviewCount = rows.reduce((max, row) => Math.max(max, row.reviewCount), 1);
  const maxLog = maxReviewCount > 1 ? Math.log(maxReviewCount) : 1;
  const confidenceThreshold = percentile(
    rows
      .map((row) => row.reviewCount)
      .filter((count) => count > 0),
    0.6,
  );
  const platformAverageRating =
    rows.reduce((sum, row) => sum + (row.rating || 0), 0) / Math.max(rows.filter((row) => row.rating > 0).length, 1);

  rows.forEach((row, index) => {
    const popularity = row.reviewCount > 1 ? Math.log(row.reviewCount) / maxLog : 0;
    const adjustedRating =
      (row.reviewCount / (row.reviewCount + confidenceThreshold)) * row.rating +
      (confidenceThreshold / (row.reviewCount + confidenceThreshold)) * platformAverageRating;
    const weightedQualityRating = row.rating * 0.6 + adjustedRating * 0.4;
    const quality = clamp((weightedQualityRating - 3) / 2, 0, 1);
    const hypeScore = clamp(Math.max(popularity - quality, 0), 0, 1);
    const underratedScore = clamp(Math.max(quality - popularity, 0), 0, 1);
    const reliabilityScore = clamp(popularity, 0, 1);

    let tag = "worth-it";
    let tagLabel = "Worth It";
    const mediumReliability = reliabilityScore >= 0.35;
    const hiddenGemConfidence = row.reviewCount >= confidenceThreshold || reliabilityScore >= 0.28;
    if (hypeScore > 0.2 && quality < 0.75 && mediumReliability) {
      tag = "overhyped";
      tagLabel = "Overhyped";
    } else if (underratedScore > 0.2 && quality >= 0.75 && hiddenGemConfidence) {
      tag = "hidden-gem";
      tagLabel = "Hidden Gem";
    }

    Object.assign(row, {
      popularity: Number(popularity.toFixed(6)),
      quality: Number(quality.toFixed(6)),
      adjustedRating: Number(adjustedRating.toFixed(6)),
      weightedQualityRating: Number(weightedQualityRating.toFixed(6)),
      hypeScore: Number(hypeScore.toFixed(6)),
      underratedScore: Number(underratedScore.toFixed(6)),
      reliabilityScore: Number(reliabilityScore.toFixed(6)),
      tag,
      tagLabel,
      category: categoryFromType(row.restaurantType, row.cuisine),
      image: null,
    });

    row.moodTags = deriveMoods(row);
    row.explanation = buildExplanation(row);
    row.searchText = [
      row.name,
      row.area,
      row.microArea,
      row.restaurantType,
      row.cuisine,
      row.fullAddress,
      row.description,
      row.features,
      row.tagLabel,
      row.moodTags.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  });

  const cuisines = Array.from(new Set(rows.flatMap((row) => row.cuisines))).sort((left, right) => left.localeCompare(right));
  const areas = Array.from(new Set(rows.map((row) => row.area).filter((area) => area && area !== "Unknown Area"))).sort((left, right) =>
    left.localeCompare(right),
  );
  const mapped = rows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
  const tagCounts = rows.reduce((acc, row) => {
    acc[row.tag] = (acc[row.tag] || 0) + 1;
    return acc;
  }, {});
  const areaCounts = rows.reduce((acc, row) => {
    acc[row.area] = (acc[row.area] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    meta: {
      city: "Bangalore",
      sourceFile: SOURCE_CSV,
      totalRestaurants: rows.length,
      mappedRestaurants: mapped.length,
      maxReviewCount,
      platformAverageRating: Number(platformAverageRating.toFixed(6)),
      confidenceThreshold: Number(confidenceThreshold.toFixed(6)),
      cuisines,
      areas,
      tagCounts,
      areaCounts,
      mapBounds: computeBounds(mapped),
    },
    restaurants: rows,
  };

  fs.writeFileSync(OUTPUT_FILE, `window.BLRBITES_PAYLOAD = ${JSON.stringify(payload)};\n`, "utf8");

  console.log(`Built ${rows.length} restaurants`);
  console.log(`Mapped ${mapped.length} restaurants`);
  console.log(`Cuisines ${cuisines.length}`);
  console.log(`Areas ${areas.length}`);
}

main();
