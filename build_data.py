import csv
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parent
SOURCE_CSV = Path(r"C:\Users\ASUS\Downloads\BLR_Restaurants_Clean.csv")
OUTPUT_FILE = WORKSPACE / "restaurants-data.js"

AREA_ALIASES = {
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
    "hsr": "HSR Layout",
}

ADDRESS_AREA_HINTS = [
    ("Church Street", "church street"),
    ("Bannerghatta Road", "bannerghatta"),
    ("HSR Layout", "hsr"),
    ("Indiranagar", "indiranagar"),
    ("Whitefield", "whitefield"),
    ("Koramangala", "koramangala"),
    ("Lavelle Road", "lavelle"),
    ("Brigade Road", "brigade"),
    ("Old Airport Road", "airport road"),
    ("Sarjapur Road", "sarjapur"),
    ("Electronic City", "electronic city"),
    ("MG Road", "mahatma gandhi rd"),
    ("MG Road", "mg road"),
    ("JP Nagar", "j p nagar"),
    ("JP Nagar", "jp nagar"),
]

MOJIBAKE_MARKERS = ("Ã", "Â", "â", "\ufffd")


def repair_text(value):
    if value is None:
        return ""
    text = str(value).replace("\ufeff", "").replace("\xa0", " ").strip()
    if not text:
        return ""
    candidates = [text]
    if any(marker in text for marker in MOJIBAKE_MARKERS):
        try:
            candidates.append(text.encode("latin1", errors="ignore").decode("utf-8", errors="ignore"))
        except Exception:
            pass
    scored = []
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", candidate).strip(" ,")
        weird = sum(normalized.count(marker) for marker in MOJIBAKE_MARKERS)
        scored.append((weird, -len(normalized), normalized))
    scored.sort()
    return scored[0][2]


def parse_float(value):
    text = repair_text(value)
    if not text:
        return None
    text = text.replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None


def parse_int(value):
    number = parse_float(value)
    if number is None:
        return 0
    return int(round(number))


def slugify(text):
    cleaned = repair_text(text).lower()
    cleaned = re.sub(r"[^a-z0-9]+", "-", cleaned)
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    return cleaned or "restaurant"


def normalize_area(area, address):
    source = repair_text(area)
    address_text = repair_text(address).lower()

    if source.lower().startswith("koramangala"):
        return "Koramangala", source
    if source.lower() == "hsr":
        return "HSR Layout", "HSR"

    key = source.lower()
    if key in AREA_ALIASES:
        return AREA_ALIASES[key], source

    if source:
        titled = " ".join(word.upper() if word.upper() in {"JP", "MG", "HSR", "BEL"} else word.capitalize() for word in source.split())
        return titled, source

    for label, needle in ADDRESS_AREA_HINTS:
        if needle in address_text:
            return label, ""
    return "Unknown Area", ""


def split_cuisines(text):
    cuisines = []
    for part in repair_text(text).split(","):
        item = re.sub(r"\s+", " ", part).strip(" -")
        if item:
            cuisines.append(item)
    return cuisines


def normalize_bool(value):
    text = repair_text(value).lower()
    if text in {"yes", "true", "1"}:
        return True
    if text in {"no", "false", "0"}:
        return False
    return None


def category_from_type(restaurant_type, cuisine):
    text = f"{restaurant_type} {cuisine}".lower()
    if any(token in text for token in ("dessert", "ice cream", "sweet", "waffle", "mithai")):
        return "dessert"
    if any(token in text for token in ("cafe", "coffee", "bakery", "beverage")):
        return "cafe"
    if any(token in text for token in ("bar", "pub", "brew", "lounge", "microbrew")):
        return "bar"
    return "restaurant"


def first_address_line(address):
    cleaned = repair_text(address)
    if not cleaned:
        return ""
    return cleaned.split(",")[0].strip()


def clamp(number, lower, upper):
    return max(lower, min(number, upper))


def build_explanation(restaurant):
    rating = restaurant["rating"]
    adjusted = restaurant["adjustedRating"]
    reviews = restaurant["reviewCount"]
    hype = restaurant["hypeScore"]
    underrated = restaurant["underratedScore"]
    reliability = restaurant["reliabilityScore"]
    tag = restaurant["tag"]

    if tag == "overhyped":
        if reliability >= 0.35:
            return f"Highly visible with {reviews:,} reviews, but the adjusted quality settles near {adjusted:.1f}."
        return "Visibility is outrunning quality here, so the popularity looks stronger than the food signal."
    if tag == "hidden-gem":
        if reliability >= 0.28:
            return f"Exceptional adjusted quality at {adjusted:.1f} despite lower visibility makes this a strong hidden gem."
        return "Strong quality with limited mainstream attention gives this real discovery potential."
    if reliability >= 0.5:
        return f"The adjusted score holds at {adjusted:.1f} across {reviews:,} reviews, so this reads as dependable."
    if underrated >= 0.1:
        return "Quality is quietly doing the work here even without oversized attention."
    if hype >= 0.1:
        return "Mainstream enough to be visible, but the quality signal still holds in a reasonable range."
    return "Balanced visibility, quality, and review confidence keep this in the worth-it zone."


def derive_moods(restaurant):
    moods = []
    if restaurant["hypeScore"] <= 0.18 and restaurant["reliabilityScore"] >= 0.3:
        moods.append("chill")
    if restaurant["priceRange"] and restaurant["priceRange"] <= 500 and restaurant["underratedScore"] >= 0.12:
        moods.append("budget")
    if restaurant["adjustedRating"] >= 4.2 and restaurant["reliabilityScore"] >= 0.35 and restaurant["priceRange"] >= 900:
        moods.append("fancy")
    if restaurant["underratedScore"] >= 0.16 and restaurant["popularity"] <= 0.42:
        moods.append("experimental")
    if restaurant["popularity"] >= 0.55 or restaurant["hypeScore"] >= 0.12:
        moods.append("indulgent")
    return moods


def compute_bounds(points):
    lats = [point[0] for point in points]
    lngs = [point[1] for point in points]
    south = min(lats) - 0.04
    north = max(lats) + 0.04
    west = min(lngs) - 0.04
    east = max(lngs) + 0.04
    return {
        "center": [round((west + east) / 2, 6), round((south + north) / 2, 6)],
        "southWest": [round(west, 6), round(south, 6)],
        "northEast": [round(east, 6), round(north, 6)],
    }


def percentile(values, ratio):
    if not values:
        return 1
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * ratio)))
    return ordered[index] or 1


def main():
    if not SOURCE_CSV.exists():
        raise FileNotFoundError(f"CSV not found: {SOURCE_CSV}")

    rows = []
    with SOURCE_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for index, row in enumerate(reader, start=1):
            name = repair_text(row.get("Restaurant Name"))
            if not name:
                continue

            address = repair_text(row.get("Full Address"))
            area, micro_area = normalize_area(row.get("Area"), address)
            cuisine_list = split_cuisines(row.get("Cuisines"))
            price_range = parse_int(row.get("Avg Cost (Two People ₹)"))
            rating = clamp(parse_float(row.get("Rating")) or 0, 0, 5)
            review_count = parse_int(row.get("No. of Ratings"))

            lat = parse_float(row.get("Latitude"))
            lng = parse_float(row.get("Longitude"))
            precise_coordinates = lat is not None and lng is not None

            rows.append(
                {
                    "id": f"blr-{index}",
                    "name": name,
                    "slug": f"{slugify(name)}-{index}",
                    "area": area,
                    "microArea": repair_text(micro_area),
                    "lat": lat,
                    "lng": lng,
                    "preciseCoordinates": precise_coordinates,
                    "coordinateSource": "dataset" if precise_coordinates else "missing",
                    "cuisine": ", ".join(cuisine_list),
                    "cuisines": cuisine_list,
                    "priceRange": price_range,
                    "rating": rating,
                    "reviewCount": review_count,
                    "restaurantType": repair_text(row.get("Restaurant Type")),
                    "ratingSource": repair_text(row.get("Rating Source")),
                    "zomatoRating": parse_float(row.get("Zomato Rating")),
                    "zomatoReviewCount": parse_int(row.get("Zomato No. of Ratings")),
                    "tripadvisorRating": parse_float(row.get("TripAdvisor Rating")),
                    "tripadvisorReviewCount": parse_int(row.get("TripAdvisor No. of Reviews")),
                    "swiggyRating": parse_float(row.get("Swiggy Rating")),
                    "swiggyReviewCount": parse_int(row.get("Swiggy No. of Ratings")),
                    "phone": repair_text(row.get("Phone")),
                    "fullAddress": address,
                    "localAddress": first_address_line(address),
                    "description": repair_text(row.get("Description")),
                    "dietaryRestrictions": repair_text(row.get("Dietary Restrictions")),
                    "features": repair_text(row.get("Features")),
                    "mealType": repair_text(row.get("Meal Type")),
                    "timings": repair_text(row.get("Meal Type")),
                    "onlineOrder": normalize_bool(row.get("Online Order")),
                    "tableBooking": normalize_bool(row.get("Table Booking")),
                    "deliveryTimeMins": parse_int(row.get("Delivery Time (Mins)")),
                    "dataSources": repair_text(row.get("Data Sources")),
                }
            )

    area_points = defaultdict(list)
    for row in rows:
        if row["preciseCoordinates"]:
            area_points[row["area"]].append((row["lat"], row["lng"]))

    area_centroids = {}
    for area, points in area_points.items():
        area_centroids[area] = {
            "lat": round(sum(point[0] for point in points) / len(points), 6),
            "lng": round(sum(point[1] for point in points) / len(points), 6),
        }

    for row in rows:
        if row["preciseCoordinates"]:
            continue
        centroid = area_centroids.get(row["area"])
        if centroid:
            row["lat"] = centroid["lat"]
            row["lng"] = centroid["lng"]
            row["coordinateSource"] = "area-centroid"

    max_review_count = max((row["reviewCount"] for row in rows), default=1)
    max_log = math.log(max_review_count) if max_review_count > 1 else 1

    confidence_threshold = percentile([row["reviewCount"] for row in rows if row["reviewCount"] > 0], 0.6)
    platform_average_rating = sum(row["rating"] for row in rows if row["rating"] > 0) / max(len([row for row in rows if row["rating"] > 0]), 1)

    for row in rows:
        popularity = math.log(row["reviewCount"]) / max_log if row["reviewCount"] > 1 else 0
        adjusted_rating = (
            (row["reviewCount"] / (row["reviewCount"] + confidence_threshold)) * row["rating"]
            + (confidence_threshold / (row["reviewCount"] + confidence_threshold)) * platform_average_rating
        )
        weighted_quality_rating = row["rating"] * 0.6 + adjusted_rating * 0.4
        quality = clamp((weighted_quality_rating - 3) / 2, 0, 1)
        hype_score = clamp(max(popularity - quality, 0), 0, 1)
        underrated_score = clamp(max(quality - popularity, 0), 0, 1)
        reliability_score = clamp(popularity, 0, 1)
        medium_reliability = reliability_score >= 0.35
        hidden_gem_confidence = row["reviewCount"] >= confidence_threshold or reliability_score >= 0.28

        if hype_score > 0.2 and quality < 0.75 and medium_reliability:
            tag = "overhyped"
            tag_label = "Overhyped"
        elif underrated_score > 0.2 and quality >= 0.75 and hidden_gem_confidence:
            tag = "hidden-gem"
            tag_label = "Hidden Gem"
        else:
            tag = "worth-it"
            tag_label = "Worth It"

        row["popularity"] = round(popularity, 6)
        row["quality"] = round(quality, 6)
        row["adjustedRating"] = round(adjusted_rating, 6)
        row["weightedQualityRating"] = round(weighted_quality_rating, 6)
        row["hypeScore"] = round(hype_score, 6)
        row["underratedScore"] = round(underrated_score, 6)
        row["reliabilityScore"] = round(reliability_score, 6)
        row["tag"] = tag
        row["tagLabel"] = tag_label
        row["category"] = category_from_type(row["restaurantType"], row["cuisine"])
        row["moodTags"] = derive_moods(row)
        row["explanation"] = build_explanation(row)
        row["image"] = None
        row["searchText"] = " ".join(
            filter(
                None,
                [
                    row["name"],
                    row["area"],
                    row["microArea"],
                    row["restaurantType"],
                    row["cuisine"],
                    row["fullAddress"],
                    row["description"],
                    row["features"],
                    row["tagLabel"],
                    " ".join(row["moodTags"]),
                ],
            )
        ).lower()

    cuisines = sorted({cuisine for row in rows for cuisine in row["cuisines"]})
    areas = sorted({row["area"] for row in rows if row["area"] and row["area"] != "Unknown Area"})
    mapped_points = [(row["lat"], row["lng"]) for row in rows if row["lat"] is not None and row["lng"] is not None]
    tag_counts = Counter(row["tag"] for row in rows)
    area_counts = Counter(row["area"] for row in rows)

    payload = {
        "meta": {
            "city": "Bangalore",
            "sourceFile": str(SOURCE_CSV),
            "totalRestaurants": len(rows),
            "mappedRestaurants": len(mapped_points),
            "maxReviewCount": max_review_count,
            "platformAverageRating": round(platform_average_rating, 6),
            "confidenceThreshold": round(confidence_threshold, 6),
            "cuisines": cuisines,
            "areas": areas,
            "tagCounts": dict(tag_counts),
            "areaCounts": dict(area_counts),
            "mapBounds": compute_bounds(mapped_points),
        },
        "restaurants": rows,
    }

    OUTPUT_FILE.write_text(
        "window.BLRBITES_PAYLOAD = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )

    print(f"Built {len(rows)} restaurants")
    print(f"Mapped {len(mapped_points)} restaurants")
    print(f"Cuisines {len(cuisines)}")
    print(f"Areas {len(areas)}")


if __name__ == "__main__":
    main()
