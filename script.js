(function () {
  const payload = window.BLRBITES_PAYLOAD;
  if (!payload || !Array.isArray(payload.restaurants)) {
    return;
  }

  const PAGE = document.body.dataset.page || "home";
  const STORAGE_KEYS = {
    users: "blr-bites-users-v7",
    currentUser: "blr-bites-current-user-v7",
    submissions: "blr-bites-submissions-v7",
    userLocation: "blr-bites-user-location-v7",
    favorites: "blr-bites-favorites-v7",
  };

  const TAG_META = {
    overhyped: { label: "Overhyped", color: "#cf654e" },
    "hidden-gem": { label: "Hidden Gem", color: "#5f9468" },
    "worth-it": { label: "Worth It", color: "#9f9587" },
  };

  const MOODS = [
    { id: "chill", emoji: "😌", label: "Chill" },
    { id: "indulgent", emoji: "🍔", label: "Indulgent" },
    { id: "budget", emoji: "💸", label: "Budget" },
    { id: "fancy", emoji: "✨", label: "Fancy" },
    { id: "experimental", emoji: "🌶️", label: "Experimental" },
  ];

  const PLAN_STEPS = [
    { id: "cafe", label: "Morning · Cafe" },
    { id: "lunch", label: "Lunch · Restaurant" },
    { id: "dessert", label: "Evening · Dessert" },
    { id: "dinner", label: "Dinner · Main" },
  ];

  const state = {
    users: loadJson(STORAGE_KEYS.users, []),
    currentUser: loadJson(STORAGE_KEYS.currentUser, null),
    submissions: loadJson(STORAGE_KEYS.submissions, []),
    favorites: loadJson(STORAGE_KEYS.favorites, {}),
    userLocation: loadJson(STORAGE_KEYS.userLocation, null),
    restaurants: [],
    restaurantsById: new Map(),
    visibleCount: 24,
    activeRestaurantId: "",
    hoveredRestaurantId: "",
    plannerSeed: 0,
    currentPlan: [],
    filters: {
      search: "",
      mood: "",
      tag: "",
      area: "",
      cuisine: "",
      budget: "",
      rating: "",
      sort: "recommended",
    },
    mapFilters: {
      search: "",
      mood: "",
      tag: "",
      area: "",
      cuisine: "",
      budget: "",
    },
    plannerFilters: {
      mood: "",
      area: "",
      budget: "",
      cuisine: "",
      tag: "",
      hopDistance: "4",
      userDistance: "",
    },
    mapTags: new Set(["overhyped", "hidden-gem", "worth-it"]),
  };

  const maps = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    loadPageStateFromUrl();
    rebuildRestaurants();
    populateSharedAreaList();
    bindGlobalDelegates();

    switch (PAGE) {
      case "home":
        initHomePage();
        break;
      case "explore":
        initExplorePage();
        break;
      case "map":
        initMapPage();
        break;
      case "restaurant":
        initRestaurantPage();
        break;
      case "plan":
        initPlanPage();
        break;
      case "how":
        initHowPage();
        break;
      case "add-spot":
        initAddSpotPage();
        break;
      case "sign-in":
        initAuthPage("signin");
        break;
      case "sign-up":
        initAuthPage("signup");
        break;
      default:
        break;
    }
  }

  function loadPageStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    state.filters.search = params.get("q") || "";
    state.filters.mood = params.get("mood") || "";
    state.filters.tag = params.get("tag") || "";
    state.filters.area = params.get("area") || "";
    state.filters.cuisine = params.get("cuisine") || "";
    state.filters.budget = params.get("budget") || "";
    state.filters.rating = params.get("rating") || "";
    state.filters.sort = params.get("sort") || "recommended";

    state.mapFilters.search = params.get("q") || "";
    state.mapFilters.mood = params.get("mood") || "";
    state.mapFilters.tag = params.get("tag") || "";
    state.mapFilters.area = params.get("area") || "";
    state.mapFilters.cuisine = params.get("cuisine") || "";
    state.mapFilters.budget = params.get("budget") || "";
  }

  function rebuildRestaurants() {
    const source = payload.restaurants.concat(state.submissions.map(normalizeSubmissionRecord));
    const maxReviewCount = source.reduce((max, item) => Math.max(max, Number(item.reviewCount) || 0), 1);
    const maxLog = maxReviewCount > 1 ? Math.log(maxReviewCount) : 1;
    const confidenceThreshold = percentile(
      source
        .map((item) => Math.max(0, Number(item.reviewCount) || 0))
        .filter((count) => count > 0),
      0.6,
    );
    const platformAverageRating =
      source.reduce((sum, item) => sum + clamp(Number(item.rating) || 0, 0, 5), 0) / Math.max(source.filter((item) => (Number(item.rating) || 0) > 0).length, 1);
    const baseSignals = source.map((item) => {
      const rating = clamp(Number(item.rating) || 0, 0, 5);
      const reviewCount = Math.max(0, Number(item.reviewCount) || 0);
      const popularity = reviewCount > 1 && maxLog ? Math.log(reviewCount) / maxLog : 0;
      const adjustedRating =
        (reviewCount / (reviewCount + confidenceThreshold)) * rating +
        (confidenceThreshold / (reviewCount + confidenceThreshold)) * platformAverageRating;
      const weightedQualityRating = rating * 0.6 + adjustedRating * 0.4;
      const quality = clamp((weightedQualityRating - 3) / 2, 0, 1);
      return {
        rating,
        reviewCount,
        adjustedRating,
        weightedQualityRating,
        quality,
        popularity,
        rawHype: Math.max(popularity - quality, 0),
        rawUnderrated: Math.max(quality - popularity, 0),
      };
    });
    state.restaurants = source.map((item, index) => decorateRestaurant(item, baseSignals[index], { confidenceThreshold, platformAverageRating }, index));
    state.restaurantsById = new Map(state.restaurants.map((restaurant) => [restaurant.id, restaurant]));
  }

  function decorateRestaurant(item, baseSignal, modelStats, index) {
    const cuisines = Array.isArray(item.cuisines)
      ? item.cuisines.filter(Boolean)
      : String(item.cuisine || "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
    const { rating, reviewCount, adjustedRating, weightedQualityRating, quality, popularity, rawHype, rawUnderrated } = baseSignal;
    const hypeScore = clamp(rawHype, 0, 1);
    const underratedScore = clamp(rawUnderrated, 0, 1);
    const reliabilityScore = clamp(popularity, 0, 1);
    let tag = "worth-it";
    const mediumReliability = reliabilityScore >= 0.35;
    const hiddenGemConfidence = reviewCount >= modelStats.confidenceThreshold || reliabilityScore >= 0.28;
    if (hypeScore > 0.2 && quality < 0.75 && mediumReliability) {
      tag = "overhyped";
    } else if (underratedScore > 0.2 && quality >= 0.75 && hiddenGemConfidence) {
      tag = "hidden-gem";
    }

    const lat = Number(item.lat);
    const lng = Number(item.lng);
    const area = normalizeAreaForClient(item.area || item.microArea || "Unknown Area");
    const searchText = [
      item.searchText,
      item.name,
      area,
      item.microArea,
      item.restaurantType,
      item.cuisine,
      item.fullAddress,
      item.description,
      item.features,
      TAG_META[tag].label,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const restaurant = {
      ...item,
      mapIndex: index,
      area,
      cuisines,
      cuisine: cuisines.join(", "),
      rating,
      reviewCount,
      adjustedRating,
      weightedQualityRating,
      quality,
      popularity,
      hypeScore,
      underratedScore,
      reliabilityScore,
      tag,
      tagLabel: TAG_META[tag].label,
      lat,
      lng,
      hasMapPoint: Number.isFinite(lat) && Number.isFinite(lng),
      budgetBucket: getBudgetBucket(Number(item.priceRange) || 0),
      category: item.category || deriveCategory(item.restaurantType, item.cuisine),
      moodTags:
        Array.isArray(item.moodTags) && item.moodTags.length
          ? item.moodTags
          : deriveMoodTags({ hypeScore, underratedScore, reliabilityScore, adjustedRating, popularity, priceRange: Number(item.priceRange) || 0 }),
      explanation: item.explanation || buildExplanation({ tag, rating, adjustedRating, reviewCount, reliabilityScore, underratedScore, hypeScore }),
      searchText,
      recommendationScore: adjustedRating * 0.72 + reliabilityScore * 1.25 + underratedScore * 1.55 - hypeScore * 1.35,
    };

    return restaurant;
  }

  function initHomePage() {
    const homeSearch = byId("global-search");
    const homeForm = byId("home-search-form");
    renderMoodChips(byId("hero-moods"), state.filters.mood);
    if (homeSearch) {
      homeSearch.value = state.filters.search;
      setupHomeAutocomplete(homeSearch);
      homeSearch.addEventListener("input", debounce((event) => {
        state.filters.search = event.target.value.trim();
        renderHomePage();
      }, 140));
    }
    if (homeForm) {
      homeForm.addEventListener("submit", (event) => {
        event.preventDefault();
        navigate(buildExploreUrl({ q: state.filters.search, mood: state.filters.mood }));
      });
    }
    const homeMap = byId("home-preview-map");
    if (homeMap) {
      ensureMap("home", homeMap, { interactive: false, zoom: 10.85 });
    }
    bindMoodChipContainer(byId("hero-moods"), (mood) => {
      state.filters.mood = state.filters.mood === mood ? "" : mood;
      renderMoodChips(byId("hero-moods"), state.filters.mood);
      renderHomePage();
    });
    renderHomePage();
  }

  function setupHomeAutocomplete(input) {
    const panel = byId("home-search-suggestions");
    const wrapper = byId("home-search-autocomplete");
    if (!panel || !wrapper) return;
    let matches = [];
    let activeIndex = -1;

    const close = () => {
      panel.hidden = true;
      panel.innerHTML = "";
      activeIndex = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };

    const setActive = (nextIndex) => {
      if (!matches.length) return;
      activeIndex = (nextIndex + matches.length) % matches.length;
      panel.querySelectorAll("[data-autocomplete-id]").forEach((item, index) => {
        const isActive = index === activeIndex;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-selected", String(isActive));
        if (isActive) {
          input.setAttribute("aria-activedescendant", item.id);
          item.scrollIntoView({ block: "nearest" });
        }
      });
    };

    const selectMatch = (restaurant) => {
      input.value = restaurant.name;
      state.filters.search = restaurant.name;
      close();
      navigate(buildRestaurantUrl(restaurant.id));
    };

    const renderSuggestions = () => {
      const query = input.value.trim();
      if (!query) {
        close();
        return;
      }
      matches = getAutocompleteMatches(query, 8);
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
      activeIndex = matches.length ? 0 : -1;
      panel.innerHTML = matches.length
        ? matches
            .map((restaurant, index) => `
              <button class="autocomplete-option${index === 0 ? " active" : ""}" id="home-suggestion-${index}" type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-autocomplete-id="${escapeAttribute(restaurant.id)}">
                <strong>${highlightText(restaurant.name, query)}</strong>
                <span>${escapeHtml(restaurant.area)} | ${escapeHtml(restaurant.cuisine || "Cuisine not listed")} | ${restaurant.rating.toFixed(1)} star | ${formatNumber(restaurant.reviewCount)} reviews</span>
              </button>
            `)
            .join("")
        : `<div class="autocomplete-empty" role="status">No restaurants found</div>`;
      if (matches.length) {
        input.setAttribute("aria-activedescendant", "home-suggestion-0");
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    };

    input.addEventListener("input", renderSuggestions);
    input.addEventListener("focus", renderSuggestions);
    input.addEventListener("keydown", (event) => {
      if (panel.hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        renderSuggestions();
      }
      if (panel.hidden) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(activeIndex - 1);
      } else if (event.key === "Enter" && matches[activeIndex]) {
        event.preventDefault();
        selectMatch(matches[activeIndex]);
      } else if (event.key === "Escape") {
        close();
      }
    });

    panel.addEventListener("mousedown", (event) => {
      const option = event.target.closest("[data-autocomplete-id]");
      if (!option) return;
      event.preventDefault();
      const restaurant = state.restaurantsById.get(option.dataset.autocompleteId);
      if (restaurant) selectMatch(restaurant);
    });

    document.addEventListener("mousedown", (event) => {
      if (!wrapper.contains(event.target)) close();
    });
  }

  function getAutocompleteMatches(query, limit) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return state.restaurants
      .map((restaurant) => {
        const name = restaurant.name.toLowerCase();
        const area = restaurant.area.toLowerCase();
        const cuisine = (restaurant.cuisine || "").toLowerCase();
        const tag = restaurant.tagLabel.toLowerCase();
        const haystack = `${name} ${area} ${cuisine} ${tag}`;
        if (!tokens.every((token) => haystack.includes(token))) return null;
        let score = 0;
        const queryLower = query.toLowerCase();
        if (name === queryLower) score += 80;
        if (name.startsWith(queryLower)) score += 60;
        if (name.includes(queryLower)) score += 38;
        if (area.includes(queryLower)) score += 18;
        if (cuisine.includes(queryLower)) score += 12;
        score += restaurant.reliabilityScore * 12 + restaurant.adjustedRating;
        return { restaurant, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || right.restaurant.reviewCount - left.restaurant.reviewCount)
      .slice(0, limit)
      .map((entry) => entry.restaurant);
  }

  function renderHomePage() {
    const filtered = getFilteredRestaurants(state.filters).slice(0, 240);
    setText("stat-total", formatNumber(state.restaurants.length));
    setText("stat-mapped", formatNumber(state.restaurants.filter((item) => item.hasMapPoint).length));
    setText("stat-hidden", formatNumber(state.restaurants.filter((item) => item.tag === "hidden-gem").length));
    setText("stat-overhyped", formatNumber(state.restaurants.filter((item) => item.tag === "overhyped").length));

    renderRestaurantGrid("overhyped-grid", filtered.filter((item) => item.tag === "overhyped").sort(sorters.hype).slice(0, 6), state.filters.search);
    renderRestaurantGrid("hidden-gems-grid", filtered.filter((item) => item.tag === "hidden-gem").sort(sorters.underrated).slice(0, 3), state.filters.search);
    renderRestaurantGrid("worth-it-grid", filtered.filter((item) => item.tag === "worth-it").sort(sorters.recommended).slice(0, 3), state.filters.search);
    renderAreaGrid();
    updateMapData("home", filtered);
  }

  function renderAreaGrid() {
    const container = byId("area-grid");
    if (!container) {
      return;
    }
    const areas = groupBy(state.restaurants.filter((restaurant) => restaurant.area !== "Unknown Area"), "area");
    const topAreas = [...areas.entries()].sort((left, right) => right[1].length - left[1].length).slice(0, 8);
    container.innerHTML = topAreas
      .map(([area, restaurants]) => {
        const overhyped = restaurants.filter((item) => item.tag === "overhyped").length;
        const hidden = restaurants.filter((item) => item.tag === "hidden-gem").length;
        const worthIt = restaurants.filter((item) => item.tag === "worth-it").length;
        const avgRating = average(restaurants.map((item) => item.rating)).toFixed(1);
        return `
          <article class="area-card" data-area-link="${escapeAttribute(area)}">
            <div class="card-topline">
              <span class="card-title">${escapeHtml(area)}</span>
              <span>${formatNumber(restaurants.length)} spots</span>
            </div>
            <div class="area-stats">
              <span>Overhyped ${formatNumber(overhyped)}</span>
              <span>Hidden Gem ${formatNumber(hidden)}</span>
              <span>Worth It ${formatNumber(worthIt)}</span>
              <span>Avg rating ${avgRating}</span>
            </div>
            <p class="card-insight">Open Explore with ${escapeHtml(area)} already selected.</p>
          </article>
        `;
      })
      .join("");
  }

  function initExplorePage() {
    populateFilterSelects("filter-area", "filter-cuisine");
    renderMoodChips(byId("explore-moods"), state.filters.mood, true);
    hydrateSelect("filter-tag", state.filters.tag);
    hydrateSelect("filter-area", state.filters.area);
    hydrateSelect("filter-cuisine", state.filters.cuisine);
    hydrateSelect("filter-budget", state.filters.budget);
    hydrateSelect("filter-rating", state.filters.rating);
    hydrateSelect("filter-sort", state.filters.sort);
    const search = byId("explore-search");
    if (search) {
      search.value = state.filters.search;
      search.addEventListener("input", debounce((event) => {
        state.filters.search = event.target.value.trim();
        state.visibleCount = 24;
        syncExploreUrl();
        renderExplorePage();
      }, 140));
    }
    bindMoodChipContainer(byId("explore-moods"), (mood) => {
      state.filters.mood = state.filters.mood === mood ? "" : mood;
      renderMoodChips(byId("explore-moods"), state.filters.mood, true);
      state.visibleCount = 24;
      syncExploreUrl();
      renderExplorePage();
    });
    [
      ["filter-tag", "tag"],
      ["filter-area", "area"],
      ["filter-cuisine", "cuisine"],
      ["filter-budget", "budget"],
      ["filter-rating", "rating"],
      ["filter-sort", "sort"],
    ].forEach(([id, key]) => {
      const element = byId(id);
      if (!element) return;
      element.addEventListener("change", () => {
        state.filters[key] = element.value;
        state.visibleCount = 24;
        syncExploreUrl();
        renderExplorePage();
      });
    });
    const reset = byId("reset-explore-filters");
    if (reset) {
      reset.addEventListener("click", () => {
        state.filters = { search: "", mood: "", tag: "", area: "", cuisine: "", budget: "", rating: "", sort: "recommended" };
        state.visibleCount = 24;
        hydrateExploreControls();
        syncExploreUrl();
        renderExplorePage();
      });
    }
    const loadMore = byId("load-more");
    if (loadMore) {
      loadMore.addEventListener("click", () => {
        state.visibleCount += 18;
        renderExploreResults(getFilteredRestaurants(state.filters));
      });
    }
    const list = byId("results-list");
    if (list) {
      list.addEventListener("mouseover", (event) => {
        const card = event.target.closest("[data-restaurant-id]");
        if (!card) return;
        state.hoveredRestaurantId = card.dataset.restaurantId;
        syncMapFeatureState("explore");
      });
      list.addEventListener("mouseout", (event) => {
        if (!event.relatedTarget || !list.contains(event.relatedTarget)) {
          state.hoveredRestaurantId = "";
          syncMapFeatureState("explore");
        }
      });
      list.addEventListener("click", (event) => {
        const flyButton = event.target.closest("[data-center-map]");
        if (flyButton) {
          event.preventDefault();
          centerMapOnRestaurant("explore", flyButton.dataset.centerMap, true);
          return;
        }
      });
    }
    ensureMap("explore", byId("explore-map"), { interactive: true, zoom: 11.2 });
    bindLegendToggles();
    renderExplorePage();
  }

  function renderExplorePage() {
    const filtered = getFilteredRestaurants(state.filters);
    setText("explore-summary", `${formatNumber(filtered.length)} results across ${formatNumber(countUnique(filtered.map((item) => item.area)))} areas`);
    setText("map-summary", `${formatNumber(getMapVisibleRestaurants(filtered).length)} pins visible on the map`);
    renderExploreResults(filtered);
    updateMapData("explore", filtered);
  }

  function renderExploreResults(filtered) {
    const container = byId("results-list");
    if (!container) return;
    const visible = filtered.slice(0, state.visibleCount);
    setText("rendered-count", `${formatNumber(Math.min(state.visibleCount, filtered.length))} shown`);
    container.innerHTML = visible.length
      ? visible.map((restaurant) => renderRestaurantCard(restaurant, { query: state.filters.search, highlightActive: state.activeRestaurantId === restaurant.id, showMapAction: true })).join("")
      : renderEmptyState("No Bangalore restaurants match this filter set yet.");
    const loadMore = byId("load-more");
    if (loadMore) {
      loadMore.classList.toggle("hidden", filtered.length <= state.visibleCount);
    }
  }

  function hydrateExploreControls() {
    setInputValue("explore-search", state.filters.search);
    renderMoodChips(byId("explore-moods"), state.filters.mood, true);
    hydrateSelect("filter-tag", state.filters.tag);
    hydrateSelect("filter-area", state.filters.area);
    hydrateSelect("filter-cuisine", state.filters.cuisine);
    hydrateSelect("filter-budget", state.filters.budget);
    hydrateSelect("filter-rating", state.filters.rating);
    hydrateSelect("filter-sort", state.filters.sort);
  }

  function initMapPage() {
    populateFilterSelects("map-filter-area", "map-filter-cuisine");
    renderMoodChips(byId("map-moods"), state.mapFilters.mood, true);
    hydrateSelect("map-filter-tag", state.mapFilters.tag);
    hydrateSelect("map-filter-area", state.mapFilters.area);
    hydrateSelect("map-filter-cuisine", state.mapFilters.cuisine);
    hydrateSelect("map-filter-budget", state.mapFilters.budget);
    const mapSearch = byId("map-search");
    if (mapSearch) {
      mapSearch.value = state.mapFilters.search;
      mapSearch.addEventListener("input", debounce((event) => {
        state.mapFilters.search = event.target.value.trim();
        renderMapPage();
      }, 140));
    }
    bindMoodChipContainer(byId("map-moods"), (mood) => {
      state.mapFilters.mood = state.mapFilters.mood === mood ? "" : mood;
      renderMoodChips(byId("map-moods"), state.mapFilters.mood, true);
      renderMapPage();
    });
    [
      ["map-filter-tag", "tag"],
      ["map-filter-area", "area"],
      ["map-filter-cuisine", "cuisine"],
      ["map-filter-budget", "budget"],
    ].forEach(([id, key]) => {
      const element = byId(id);
      if (!element) return;
      element.addEventListener("change", () => {
        state.mapFilters[key] = element.value;
        renderMapPage();
      });
    });
    bindLegendToggles();
    ensureMap("full", byId("full-map"), { interactive: true, zoom: 10.95 });
    const preview = byId("map-preview-results");
    if (preview) {
      preview.addEventListener("click", (event) => {
        const target = event.target.closest("[data-map-result-id]");
        if (!target) return;
        centerMapOnRestaurant("full", target.dataset.mapResultId, true);
      });
    }
    renderMapPage();
  }

  function renderMapPage() {
    const filtered = getFilteredRestaurants({ ...state.mapFilters, rating: "", sort: "recommended" });
    const visible = getMapVisibleRestaurants(filtered);
    setText("tag-count-overhyped", formatNumber(filtered.filter((item) => item.tag === "overhyped").length));
    setText("tag-count-hidden-gem", formatNumber(filtered.filter((item) => item.tag === "hidden-gem").length));
    setText("tag-count-worth-it", formatNumber(filtered.filter((item) => item.tag === "worth-it").length));
    setText("map-page-summary", `Showing ${formatNumber(visible.length)} of ${formatNumber(filtered.length)} Bangalore spots. Zoom in to break clusters apart.`);
    const preview = byId("map-preview-results");
    if (preview) {
      preview.innerHTML = visible.slice(0, 5).map((restaurant) => `
        <article class="mini-result-card" data-map-result-id="${restaurant.id}">
          <div class="card-topline">
            <strong>${escapeHtml(restaurant.name)}</strong>
            <span class="badge ${restaurant.tag}">${escapeHtml(restaurant.tagLabel)}</span>
          </div>
          <p class="card-subline">${escapeHtml(restaurant.area)} • ${restaurant.rating.toFixed(1)} • ${formatNumber(restaurant.reviewCount)} reviews</p>
        </article>
      `).join("");
    }
    updateMapData("full", filtered);
  }

  function initRestaurantPage() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const restaurant = state.restaurantsById.get(id || "");
    const detail = byId("restaurant-detail");
    const nearby = byId("nearby-list");
    const similar = byId("similar-list");
    if (!restaurant || !detail) {
      if (detail) {
        detail.innerHTML = renderEmptyState("That restaurant profile could not be found.");
      }
      return;
    }

    detail.innerHTML = renderRestaurantDetail(restaurant);
    if (byId("restaurant-detail-map")) {
      ensureMap("detail", byId("restaurant-detail-map"), { interactive: false, zoom: 13.4, singleRestaurant: restaurant });
      updateDetailMap(restaurant);
    }

    const nearbyRestaurants = state.restaurants
      .filter((item) => item.id !== restaurant.id && item.hasMapPoint && restaurant.hasMapPoint)
      .map((item) => ({ ...item, distance: haversineKm(restaurant, item) }))
      .filter((item) => item.distance <= 4.5)
      .sort((left, right) => left.distance - right.distance || sorters.recommended(left, right))
      .slice(0, 4);

    const similarRestaurants = state.restaurants
      .filter((item) => item.id !== restaurant.id)
      .map((item) => ({ ...item, similarity: getSimilarityScore(restaurant, item) }))
      .filter((item) => item.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity || sorters.recommended(left, right))
      .slice(0, 4);

    if (nearby) {
      nearby.innerHTML = nearbyRestaurants.length
        ? nearbyRestaurants.map((item) => renderRestaurantCard(item, { query: "", showDistance: item.distance })).join("")
        : renderEmptyState("No nearby restaurants with matching map coordinates were found.");
    }
    if (similar) {
      similar.innerHTML = similarRestaurants.length
        ? similarRestaurants.map((item) => renderRestaurantCard(item, { query: "" })).join("")
        : renderEmptyState("No similar restaurants were found yet.");
    }
  }

  function initPlanPage() {
    populateFilterSelects("planner-area", "planner-cuisine");
    renderMoodChips(byId("planner-moods"), state.plannerFilters.mood, true);
    hydrateSelect("planner-area", state.plannerFilters.area);
    hydrateSelect("planner-budget", state.plannerFilters.budget);
    hydrateSelect("planner-cuisine", state.plannerFilters.cuisine);
    hydrateSelect("planner-tag", state.plannerFilters.tag);
    hydrateSelect("planner-hop-distance", state.plannerFilters.hopDistance);
    hydrateSelect("planner-user-distance", state.plannerFilters.userDistance);
    bindMoodChipContainer(byId("planner-moods"), (mood) => {
      state.plannerFilters.mood = state.plannerFilters.mood === mood ? "" : mood;
      renderMoodChips(byId("planner-moods"), state.plannerFilters.mood, true);
    });
    [
      ["planner-area", "area"],
      ["planner-budget", "budget"],
      ["planner-cuisine", "cuisine"],
      ["planner-tag", "tag"],
      ["planner-hop-distance", "hopDistance"],
      ["planner-user-distance", "userDistance"],
    ].forEach(([id, key]) => {
      const element = byId(id);
      if (!element) return;
      element.addEventListener("change", () => {
        state.plannerFilters[key] = element.value;
      });
    });
    const form = byId("planner-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        buildPlan();
      });
    }
    const shuffle = byId("shuffle-plan");
    if (shuffle) {
      shuffle.addEventListener("click", (event) => {
        event.preventDefault();
        state.plannerSeed += 1;
        buildPlan();
      });
    }
    const useLocation = byId("use-location");
    if (useLocation) {
      useLocation.addEventListener("click", async (event) => {
        event.preventDefault();
        if (!navigator.geolocation) {
          showToast("Geolocation is not available in this browser.");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (position) => {
            state.userLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
            saveJson(STORAGE_KEYS.userLocation, state.userLocation);
            showToast("Current location saved for planning.");
          },
          () => showToast("Could not access your current location."),
          { enableHighAccuracy: true, timeout: 10000 },
        );
      });
    }
    buildPlan();
  }

  function buildPlan() {
    const hopLimit = Number(state.plannerFilters.hopDistance || 4);
    const userLimit = Number(state.plannerFilters.userDistance || 0);
    let pool = getFilteredRestaurants({
      search: "",
      mood: state.plannerFilters.mood,
      tag: state.plannerFilters.tag,
      area: state.plannerFilters.area,
      cuisine: state.plannerFilters.cuisine,
      budget: state.plannerFilters.budget,
      rating: "",
      sort: "recommended",
    });

    if (userLimit && state.userLocation) {
      pool = pool.filter((item) => item.hasMapPoint && haversineKm(state.userLocation, item) <= userLimit);
    }

    const stepPools = {
      cafe: pool.filter(isCafeLike),
      lunch: pool.filter(isLunchLike),
      dessert: pool.filter(isDessertLike),
      dinner: pool.filter(isDinnerLike),
    };

    const used = new Set();
    const plan = [];
    let previous = null;
    PLAN_STEPS.forEach((step, index) => {
      const candidates = shuffleBySeed(stepPools[step.id].filter((item) => !used.has(item.id)), state.plannerSeed + index)
        .map((restaurant) => ({
          restaurant,
          distance: previous && previous.hasMapPoint && restaurant.hasMapPoint ? haversineKm(previous, restaurant) : 0,
          score: getPlannerCandidateScore(previous, restaurant, hopLimit),
        }))
        .sort((left, right) => right.score - left.score);

      const picked = candidates.find((candidate) => !previous || candidate.distance <= hopLimit || !candidate.restaurant.hasMapPoint) || candidates[0];
      if (!picked) {
        return;
      }
      used.add(picked.restaurant.id);
      previous = picked.restaurant;
      plan.push({
        step,
        restaurant: picked.restaurant,
        distanceFromPrevious: picked.distance,
      });
    });

    state.currentPlan = plan;
    renderPlan(plan, pool.length);
  }

  function renderPlan(plan, poolSize) {
    const summary = byId("planner-summary");
    const container = byId("plan-timeline");
    if (!summary || !container) {
      return;
    }
    if (!plan.length) {
      summary.textContent = "No itinerary fit this mix of mood, budget, area, and distance. Try relaxing one filter.";
      container.innerHTML = renderEmptyState("No route could be generated from the current filters.");
      return;
    }

    const totalCost = plan.reduce((sum, item) => sum + (Number(item.restaurant.priceRange) || 0), 0);
    const totalDistance = plan.reduce((sum, item) => sum + (Number(item.distanceFromPrevious) || 0), 0);
    summary.textContent = `Built from ${formatNumber(poolSize)} restaurants. Estimated spend ${formatCurrency(totalCost)} • route distance ${formatDistance(totalDistance)}.`;

    container.innerHTML = plan
      .map((item, index) => `
        <article class="timeline-card">
          <div class="timeline-step">
            <span class="timeline-step-number">${index + 1}</span>
            <span class="timeline-step-label">${escapeHtml(item.step.label)}</span>
          </div>
          <div class="timeline-card-body">
            <div class="card-topline">
              <h3>${escapeHtml(item.restaurant.name)}</h3>
              <span class="badge ${item.restaurant.tag}">${escapeHtml(item.restaurant.tagLabel)}</span>
            </div>
            <div class="card-meta">
              <span>${escapeHtml(item.restaurant.area)}</span>
              <span>${item.restaurant.rating.toFixed(1)} ★</span>
              <span>${formatNumber(item.restaurant.reviewCount)} reviews</span>
              <span>${item.restaurant.priceRange ? formatCurrency(item.restaurant.priceRange) : "Price not listed"}</span>
              ${index === 0 ? "" : `<span>${formatDistance(item.distanceFromPrevious)} from previous</span>`}
            </div>
            <div class="card-cuisine">${escapeHtml(item.restaurant.cuisine || "Cuisine not listed")}</div>
            <p class="card-insight">${escapeHtml(item.restaurant.explanation)}</p>
            <div class="card-actions">
              <a class="mini-text-button" href="${buildRestaurantUrl(item.restaurant.id)}">View profile</a>
              ${item.restaurant.hasMapPoint ? `<a class="mini-text-button" href="${buildMapUrlForRestaurant(item.restaurant)}">Open on map</a>` : ""}
            </div>
          </div>
        </article>
      `)
      .join("");
  }

  function initHowPage() {
    renderScatterPlot();
  }

  function initAddSpotPage() {
    renderAddSpotAccess();
    renderSubmissionList();
    const form = byId("spot-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitSpot(form);
      });
    }
  }

  function renderAddSpotAccess() {
    const gate = byId("add-spot-gate");
    const form = byId("spot-form");
    const signedIn = !!state.currentUser;
    if (gate) gate.hidden = signedIn;
    if (form) form.hidden = !signedIn;
  }

  function submitSpot(form) {
    if (!state.currentUser) {
      showToast("Sign in before submitting a new spot.");
      navigate("sign-in.html");
      return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    const name = String(values.name || "").trim();
    const area = normalizeAreaForClient(values.area || "");
    const duplicate = state.restaurants.find((restaurant) => slugify(restaurant.name) === slugify(name) && restaurant.area === area);
    if (duplicate) {
      showToast("That restaurant already exists in BLR Bites.");
      return;
    }

    const areaCentroid = getAreaCentroid(area);
    const lat = values.lat ? Number(values.lat) : areaCentroid?.lat;
    const lng = values.lng ? Number(values.lng) : areaCentroid?.lng;
    const submission = {
      id: `submission-${Date.now()}`,
      contributorEmail: state.currentUser.email,
      status: "Pending review",
      submittedAt: new Date().toISOString(),
      name,
      area,
      cuisine: String(values.cuisine || "").trim(),
      cuisines: String(values.cuisine || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      priceRange: Number(values.priceRange) || 0,
      rating: Number(values.rating) || 0,
      reviewCount: Number(values.reviewCount) || 0,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      fullAddress: String(values.fullAddress || "").trim(),
      phone: String(values.phone || "").trim(),
      description: String(values.description || "").trim(),
      restaurantType: String(values.restaurantType || "").trim(),
    };
    state.submissions.unshift(submission);
    saveJson(STORAGE_KEYS.submissions, state.submissions);
    form.reset();
    rebuildRestaurants();
    renderSubmissionList();
    showToast("Spot submitted successfully.");
  }

  function renderSubmissionList() {
    const container = byId("submission-list");
    if (!container) return;
    const mine = state.currentUser ? state.submissions.filter((submission) => submission.contributorEmail === state.currentUser.email) : [];
    setText("submission-count", formatNumber(mine.length));
    container.innerHTML = mine.length
      ? mine
          .map(
            (submission) => `
              <article class="submission-card">
                <div class="card-topline">
                  <span class="card-title">${escapeHtml(submission.name)}</span>
                  <span class="badge worth-it">${escapeHtml(submission.status)}</span>
                </div>
                <div class="submission-meta">
                  <span>${escapeHtml(submission.area)}</span>
                  <span>${escapeHtml(submission.cuisine || "Cuisine not listed")}</span>
                  <span>${formatDate(submission.submittedAt)}</span>
                </div>
                <p class="card-insight">${escapeHtml(submission.description || "Awaiting editorial review.")}</p>
              </article>
            `,
          )
          .join("")
      : renderEmptyState("No submissions yet. Sign in and add a missing Bangalore spot.");
  }

  function initAuthPage(mode) {
    const form = byId("auth-form");
    if (!form) return;
    renderProfileState();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      mode === "signup" ? handleSignUp() : handleSignIn();
    });
  }

  function handleSignUp() {
    const values = {
      displayName: byId("auth-display-name")?.value.trim() || "",
      email: byId("auth-email")?.value.trim().toLowerCase() || "",
      password: byId("auth-password")?.value || "",
    };
    const validation = validateAuth(values, true);
    if (!validation.ok) {
      setText("auth-status", validation.message);
      return;
    }
    if (state.users.some((user) => user.email === values.email)) {
      setText("auth-status", "That email is already registered.");
      return;
    }
    const user = {
      id: `user-${Date.now()}`,
      displayName: values.displayName,
      email: values.email,
      password: values.password,
    };
    state.users.push(user);
    state.currentUser = { id: user.id, email: user.email, displayName: user.displayName };
    saveJson(STORAGE_KEYS.users, state.users);
    saveJson(STORAGE_KEYS.currentUser, state.currentUser);
    setText("auth-status", "Account created. You're now signed in.");
    renderProfileState();
    showToast("Welcome to BLR Bites.");
  }

  function handleSignIn() {
    const values = {
      email: byId("auth-email")?.value.trim().toLowerCase() || "",
      password: byId("auth-password")?.value || "",
    };
    const validation = validateAuth(values, false);
    if (!validation.ok) {
      setText("auth-status", validation.message);
      return;
    }
    const user = state.users.find((entry) => entry.email === values.email && entry.password === values.password);
    if (!user) {
      setText("auth-status", "No account matched that email and password.");
      return;
    }
    state.currentUser = { id: user.id, email: user.email, displayName: user.displayName };
    saveJson(STORAGE_KEYS.currentUser, state.currentUser);
    setText("auth-status", `Signed in as ${user.displayName}.`);
    renderProfileState();
    showToast("Signed in successfully.");
  }

  function renderProfileState() {
    const container = byId("profile-state");
    if (!container) return;
    if (!state.currentUser) {
      container.innerHTML = renderEmptyState("You're not signed in yet.");
      return;
    }
    const favorites = getFavoriteIds();
    const submissions = state.submissions.filter((submission) => submission.contributorEmail === state.currentUser.email).length;
    container.innerHTML = `
      <div class="profile-card">
        <strong>${escapeHtml(state.currentUser.displayName)}</strong>
        <p class="card-subline">${escapeHtml(state.currentUser.email)}</p>
        <div class="card-meta">
          <span>${formatNumber(favorites.length)} favourites</span>
          <span>${formatNumber(submissions)} submissions</span>
        </div>
        <div class="inline-actions">
          <button class="ghost-button compact-button" data-signout type="button">Sign out</button>
          <a class="ghost-button compact-button" href="add-a-spot.html">Add a spot</a>
        </div>
      </div>
    `;
  }

  function bindGlobalDelegates() {
    document.body.addEventListener("click", (event) => {
      const signout = event.target.closest("[data-signout]");
      const favorite = event.target.closest("[data-favorite-id]");
      const areaLink = event.target.closest("[data-area-link]");
      if (signout) {
        state.currentUser = null;
        saveJson(STORAGE_KEYS.currentUser, null);
        renderProfileState();
        renderAddSpotAccess();
        showToast("Signed out.");
      }
      if (favorite) {
        const restaurantId = favorite.dataset.favoriteId;
        toggleFavorite(restaurantId);
      }
      if (areaLink) {
        navigate(buildExploreUrl({ area: areaLink.dataset.areaLink }));
      }
    });
  }

  function renderRestaurantGrid(id, restaurants, query) {
    const container = byId(id);
    if (!container) return;
    container.innerHTML = restaurants.length
      ? restaurants.map((restaurant) => renderRestaurantCard(restaurant, { query })).join("")
      : renderEmptyState("No restaurants matched this selection.");
  }

  function renderRestaurantCard(restaurant, options = {}) {
    const query = options.query || "";
    const distance = Number.isFinite(options.showDistance) ? `<span>${formatDistance(options.showDistance)}</span>` : "";
    const activeClass = options.highlightActive ? " active" : "";
    return `
      <article class="restaurant-card${activeClass}" data-restaurant-id="${restaurant.id}">
        <div class="card-topline">
          <div>
            <a class="card-title" href="${buildRestaurantUrl(restaurant.id)}">${highlightText(restaurant.name, query)}</a>
            <div class="card-subline">${highlightText(restaurant.area, query)}${restaurant.restaurantType ? ` • ${escapeHtml(restaurant.restaurantType)}` : ""}</div>
          </div>
          <span class="badge ${restaurant.tag}">${escapeHtml(restaurant.tagLabel)}</span>
        </div>
        <div class="card-cuisine">${highlightText(restaurant.cuisine || "Cuisine not listed", query)}</div>
        <div class="card-meta">
          <span>${restaurant.rating.toFixed(1)} ★</span>
          <span>${formatNumber(restaurant.reviewCount)} reviews</span>
          <span>${restaurant.priceRange ? `${formatCurrency(restaurant.priceRange)} for two` : "Price not listed"}</span>
          ${distance}
        </div>
        <p class="card-insight">${escapeHtml(restaurant.explanation)}</p>
        <div class="score-grid">
          ${renderScoreBar("Hype", restaurant.hypeScore, "overhyped")}
          ${renderScoreBar("Underrated", restaurant.underratedScore, "hidden-gem")}
          ${renderScoreBar("Reliability", restaurant.reliabilityScore, "worth-it")}
        </div>
        <div class="card-actions">
          <a class="mini-text-button" href="${buildRestaurantUrl(restaurant.id)}">View profile</a>
          ${options.showMapAction && restaurant.hasMapPoint ? `<button class="mini-text-button" data-center-map="${restaurant.id}" type="button">Spot on map</button>` : ""}
        </div>
      </article>
    `;
  }

  function renderRestaurantDetail(restaurant) {
    const isFavorite = getFavoriteIds().includes(restaurant.id);
    const moodBadges = restaurant.moodTags.length
      ? restaurant.moodTags.map((mood) => `<span class="metric-badge worth-it">${escapeHtml(getMoodLabel(mood))}</span>`).join("")
      : `<span class="metric-badge worth-it">Open-ended mood fit</span>`;
    return `
      <article class="detail-hero-card">
        <p class="eyebrow">Restaurant detail</p>
        <div class="card-topline">
          <div>
            <h1>${escapeHtml(restaurant.name)}</h1>
          <div class="card-meta">
            <span>${escapeHtml(restaurant.area)}</span>
            ${restaurant.microArea && restaurant.microArea !== restaurant.area ? `<span>${escapeHtml(restaurant.microArea)}</span>` : ""}
            <span>${restaurant.rating.toFixed(1)} ★</span>
            <span>Adj ${restaurant.adjustedRating.toFixed(1)}</span>
            <span>${formatNumber(restaurant.reviewCount)} reviews</span>
          </div>
          </div>
          <div class="inline-actions">
            <span class="badge ${restaurant.tag}">${escapeHtml(restaurant.tagLabel)}</span>
            <button class="ghost-button compact-button" data-favorite-id="${restaurant.id}" type="button">${isFavorite ? "Saved" : "Save favourite"}</button>
          </div>
        </div>
        <p class="hero-subtitle">${escapeHtml(restaurant.explanation)}</p>
        <div class="detail-score-grid">
          ${renderScoreBlock("Hype score", restaurant.hypeScore, "overhyped")}
          ${renderScoreBlock("Underrated score", restaurant.underratedScore, "hidden-gem")}
          ${renderScoreBlock("Reliability score", restaurant.reliabilityScore, "worth-it")}
        </div>
      </article>

      <article class="detail-panel">
        <div class="detail-fact-grid">
          <div><strong>Cuisine</strong><span>${escapeHtml(restaurant.cuisine || "Not listed")}</span></div>
          <div><strong>Cost for two</strong><span>${restaurant.priceRange ? formatCurrency(restaurant.priceRange) : "Not listed"}</span></div>
          <div><strong>Category</strong><span>${escapeHtml(toTitleCase(restaurant.category))}</span></div>
          <div><strong>Adjusted rating</strong><span>${restaurant.adjustedRating.toFixed(2)}</span></div>
          <div><strong>Rating source</strong><span>${escapeHtml(restaurant.ratingSource || "Combined source")}</span></div>
          <div><strong>Address</strong><span>${escapeHtml(restaurant.fullAddress || restaurant.area)}</span></div>
          <div><strong>Phone</strong><span>${escapeHtml(restaurant.phone || "Not listed")}</span></div>
        </div>
      </article>

      <article class="detail-panel">
        <strong>Why BLR Bites reads it this way</strong>
        <p class="restaurant-summary-text">${escapeHtml(restaurant.description || restaurant.explanation)}</p>
        <div class="inline-actions">${moodBadges}</div>
      </article>
    `;
  }

  function renderScatterPlot() {
    const container = byId("scatter-plot");
    if (!container) return;
    const sampleSize = 340;
    const restaurants = shuffleBySeed([...state.restaurants], 7).slice(0, sampleSize);
    const width = 720;
    const height = 460;
    const padding = { top: 40, right: 36, bottom: 60, left: 72 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    const points = restaurants
      .map((restaurant) => {
        const x = padding.left + restaurant.popularity * plotWidth;
        const displayQuality = clamp(Math.sqrt(restaurant.quality) * 0.86 + restaurant.quality * 0.14, 0, 1);
        const y = padding.top + (1 - displayQuality) * plotHeight;
        const color = TAG_META[restaurant.tag].color;
        return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${color}" fill-opacity="0.82"></circle>`;
      })
      .join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Popularity versus quality scatter plot">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#fffdf9"></rect>
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="rgba(57,52,46,0.2)"></line>
        <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top + plotHeight}" stroke="rgba(57,52,46,0.2)"></line>
        <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top}" stroke="rgba(180,109,83,0.18)" stroke-dasharray="6 6"></line>
        ${points}
        <text x="${width / 2}" y="${height - 18}" text-anchor="middle" fill="#6b655e" font-size="13">Popularity (log reviews) -></text>
        <text x="20" y="${height / 2}" text-anchor="middle" fill="#6b655e" font-size="13" transform="rotate(-90 20 ${height / 2})">Adjusted Quality -></text>
        <g transform="translate(${padding.left},${height - 36})">
          <circle cx="0" cy="0" r="4" fill="${TAG_META.overhyped.color}"></circle>
          <text x="10" y="4" fill="#6b655e" font-size="12">Overhyped</text>
          <circle cx="110" cy="0" r="4" fill="${TAG_META["hidden-gem"].color}"></circle>
          <text x="120" y="4" fill="#6b655e" font-size="12">Hidden Gem</text>
          <circle cx="226" cy="0" r="4" fill="${TAG_META["worth-it"].color}"></circle>
          <text x="236" y="4" fill="#6b655e" font-size="12">Worth It</text>
        </g>
      </svg>
    `;
  }

  function ensureMap(key, container, options) {
    if (!container || !window.maplibregl) return;
    if (maps[key]) return maps[key];
    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [
              "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
              "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
              "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
            ],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: payload.meta.mapBounds.center,
      zoom: options.zoom || 11,
      interactive: options.interactive !== false,
      maxBounds: [payload.meta.mapBounds.southWest, payload.meta.mapBounds.northEast],
    });

    if (options.interactive !== false) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    }

    maps[key] = { map, ready: false, popup: null, singleRestaurant: options.singleRestaurant || null };

    map.on("load", () => {
      const sourceId = `${key}-restaurants`;
      map.addSource(sourceId, {
        type: "geojson",
        data: emptyFeatureCollection(),
        cluster: key !== "detail",
        clusterRadius: 46,
        clusterMaxZoom: 12,
      });

      if (key !== "detail") {
        map.addLayer({
          id: `${key}-clusters`,
          type: "circle",
          source: sourceId,
          filter: ["has", "point_count"],
          paint: {
            "circle-color": ["step", ["get", "point_count"], "#d8cbbb", 25, "#c1af99", 100, "#a78f78"],
            "circle-radius": ["step", ["get", "point_count"], 18, 25, 24, 100, 30],
            "circle-stroke-color": "#fffdf8",
            "circle-stroke-width": 2,
          },
        });
        map.addLayer({
          id: `${key}-cluster-count`,
          type: "symbol",
          source: sourceId,
          filter: ["has", "point_count"],
          layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Open Sans Bold"] },
          paint: { "text-color": "#fff" },
        });
      }

      map.addLayer({
        id: `${key}-points`,
        type: "circle",
        source: sourceId,
        filter: key === "detail" ? ["all"] : ["!", ["has", "point_count"]],
        paint: {
          "circle-color": ["match", ["get", "tag"], "overhyped", TAG_META.overhyped.color, "hidden-gem", TAG_META["hidden-gem"].color, TAG_META["worth-it"].color],
          "circle-radius": ["case", ["boolean", ["feature-state", "active"], false], 10, ["boolean", ["feature-state", "hover"], false], 8.4, ["interpolate", ["linear"], ["zoom"], 10, 4.8, 14, 8]],
          "circle-stroke-color": "#fffdf8",
          "circle-stroke-width": ["case", ["boolean", ["feature-state", "active"], false], 2.8, ["boolean", ["feature-state", "hover"], false], 2.2, 1.4],
        },
      });

      bindMapEvents(key);
      maps[key].ready = true;
      if (key === "detail" && options.singleRestaurant) {
        updateDetailMap(options.singleRestaurant);
      } else if (key === "home") {
        renderHomePage();
      } else if (key === "explore") {
        renderExplorePage();
      } else if (key === "full") {
        renderMapPage();
      }
      window.setTimeout(() => map.resize(), 180);
    });

    return maps[key];
  }

  function bindMapEvents(key) {
    const entry = maps[key];
    if (!entry) return;
    const { map } = entry;
    const clusterLayer = `${key}-clusters`;
    const pointLayer = `${key}-points`;
    const sourceId = `${key}-restaurants`;

    if (key !== "detail") {
      map.on("click", clusterLayer, (event) => {
        const feature = event.features && event.features[0];
        if (!feature) return;
        const clusterId = feature.properties.cluster_id;
        map.getSource(sourceId).getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return;
          map.easeTo({ center: feature.geometry.coordinates, zoom });
        });
      });
    }

    map.on("mouseenter", pointLayer, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", pointLayer, () => {
      map.getCanvas().style.cursor = "";
    });
    map.on("click", pointLayer, (event) => {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const restaurant = state.restaurantsById.get(feature.properties.id);
      if (!restaurant) return;
      if (key === "explore") {
        state.activeRestaurantId = restaurant.id;
        centerMapOnRestaurant("explore", restaurant.id, false);
        syncMapFeatureState("explore");
        scrollCardIntoView(restaurant.id);
      } else if (key === "full") {
        openMapPopup(key, restaurant, event.lngLat);
      } else if (key === "detail") {
        openMapPopup(key, restaurant, event.lngLat);
      }
    });
  }

  function updateMapData(key, restaurants) {
    const entry = maps[key];
    if (!entry || !entry.ready) return;
    const visible = key === "home" ? restaurants.slice(0, 600) : getMapVisibleRestaurants(restaurants);
    const features = visible.filter((restaurant) => restaurant.hasMapPoint).map((restaurant) => restaurantToFeature(restaurant));
    const source = entry.map.getSource(`${key}-restaurants`);
    if (source) {
      source.setData({ type: "FeatureCollection", features });
      syncMapFeatureState(key);
      if (key === "home" && features.length) {
        entry.map.fitBounds([payload.meta.mapBounds.southWest, payload.meta.mapBounds.northEast], { padding: 20, duration: 0 });
      }
    }
  }

  function updateDetailMap(restaurant) {
    const entry = maps.detail;
    if (!entry || !entry.ready) return;
    const source = entry.map.getSource("detail-restaurants");
    if (!source) return;
    source.setData({ type: "FeatureCollection", features: [restaurantToFeature(restaurant)] });
    entry.map.easeTo({ center: [restaurant.lng, restaurant.lat], zoom: 13.5, duration: 0 });
  }

  function syncMapFeatureState(key) {
    const entry = maps[key];
    if (!entry || !entry.ready) return;
    const ids = getMapVisibleRestaurantsForState(key).map((restaurant) => restaurant.id);
    ids.forEach((id) => {
      entry.map.setFeatureState({ source: `${key}-restaurants`, id }, { hover: id === state.hoveredRestaurantId, active: id === state.activeRestaurantId });
    });
  }

  function centerMapOnRestaurant(key, restaurantId, openPopup) {
    const restaurant = state.restaurantsById.get(restaurantId);
    const entry = maps[key];
    if (!restaurant || !entry || !restaurant.hasMapPoint) return;
    state.activeRestaurantId = restaurantId;
    entry.map.easeTo({ center: [restaurant.lng, restaurant.lat], zoom: Math.max(entry.map.getZoom(), 13.2) });
    syncMapFeatureState(key);
    if (openPopup) {
      openMapPopup(key, restaurant, { lng: restaurant.lng, lat: restaurant.lat });
    }
  }

  function openMapPopup(key, restaurant, lngLat) {
    const entry = maps[key];
    if (!entry) return;
    if (entry.popup) {
      entry.popup.remove();
    }
    entry.popup = new maplibregl.Popup({ closeButton: false, offset: 18, maxWidth: "280px" })
      .setLngLat(lngLat)
      .setHTML(`
        <article class="popup-card">
          <h3>${escapeHtml(restaurant.name)}</h3>
          <p>${escapeHtml(restaurant.area)} • ${restaurant.rating.toFixed(1)} • ${formatNumber(restaurant.reviewCount)} reviews</p>
          <p>${escapeHtml(restaurant.explanation)}</p>
          <div class="inline-actions">
            <a class="mini-text-button" href="${buildRestaurantUrl(restaurant.id)}">View profile</a>
            <a class="mini-text-button" href="${buildExploreUrl({ area: restaurant.area, q: restaurant.name })}">Open in Explore</a>
          </div>
        </article>
      `)
      .addTo(entry.map);
  }

  function bindLegendToggles() {
    document.querySelectorAll("[data-map-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const tag = button.dataset.mapToggle;
        if (state.mapTags.has(tag)) {
          state.mapTags.delete(tag);
        } else {
          state.mapTags.add(tag);
        }
        document.querySelectorAll(`[data-map-toggle="${tag}"]`).forEach((item) => item.classList.toggle("active", state.mapTags.has(tag)));
        if (PAGE === "explore") {
          renderExplorePage();
        } else if (PAGE === "map") {
          renderMapPage();
        }
      });
    });
  }

  function populateFilterSelects(areaId, cuisineId) {
    populateSelect(byId(areaId), payload.meta.areas, PAGE === "map" ? "All areas" : "All areas");
    populateSelect(byId(cuisineId), payload.meta.cuisines, PAGE === "map" ? "All cuisines" : "All cuisines");
    if (PAGE === "plan") {
      populateSelect(byId("planner-area"), payload.meta.areas, "Anywhere");
      populateSelect(byId("planner-cuisine"), payload.meta.cuisines, "Any cuisine");
    }
  }

  function populateSharedAreaList() {
    const datalist = byId("area-options");
    if (!datalist) return;
    datalist.innerHTML = payload.meta.areas.map((area) => `<option value="${escapeAttribute(area)}"></option>`).join("");
  }

  function populateSelect(element, values, placeholder) {
    if (!element) return;
    const current = element.value || "";
    element.innerHTML = [`<option value="">${placeholder}</option>`, ...values.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`)].join("");
    if (values.includes(current)) {
      element.value = current;
    }
  }

  function bindMoodChipContainer(container, handler) {
    if (!container) return;
    container.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-mood-id]");
      if (!chip) return;
      handler(chip.dataset.moodId);
    });
  }

  function renderMoodChips(container, activeMood, compact) {
    if (!container) return;
    const className = compact ? "mini-chip" : "mood-chip";
    container.innerHTML = MOODS.map((mood) => `
      <button class="${className}${mood.id === activeMood ? " active" : ""}" data-mood-id="${mood.id}" type="button">
        ${escapeHtml(mood.emoji)} ${escapeHtml(mood.label)}
      </button>
    `).join("");
  }

  function getFilteredRestaurants(filters) {
    const tokens = getSearchTokens(filters.search);
    const threshold = Number(filters.rating || 0);
    const filtered = state.restaurants.filter((restaurant) => {
      if (tokens.length && !tokens.every((token) => restaurant.searchText.includes(token))) return false;
      if (filters.mood && !restaurant.moodTags.includes(filters.mood) && !matchesMood(restaurant, filters.mood)) return false;
      if (filters.tag && restaurant.tag !== filters.tag) return false;
      if (filters.area && restaurant.area !== filters.area) return false;
      if (filters.cuisine && !restaurant.cuisines.includes(filters.cuisine)) return false;
      if (filters.budget && restaurant.budgetBucket !== filters.budget) return false;
      if (threshold && restaurant.rating < threshold) return false;
      return true;
    });
    return filtered.sort(sorters[filters.sort || "recommended"] || sorters.recommended);
  }

  function getMapVisibleRestaurants(restaurants) {
    return restaurants.filter((restaurant) => state.mapTags.has(restaurant.tag));
  }

  function getMapVisibleRestaurantsForState(key) {
    if (key === "explore") return getMapVisibleRestaurants(getFilteredRestaurants(state.filters));
    if (key === "full") return getMapVisibleRestaurants(getFilteredRestaurants({ ...state.mapFilters, rating: "", sort: "recommended" }));
    if (key === "home") return state.restaurants;
    if (key === "detail" && maps.detail?.singleRestaurant) return [maps.detail.singleRestaurant];
    return [];
  }

  function matchesMood(restaurant, mood) {
    switch (mood) {
      case "chill":
        return restaurant.hypeScore <= 0.18 && restaurant.reliabilityScore >= 0.3;
      case "budget":
        return restaurant.priceRange > 0 && restaurant.priceRange <= 500 && restaurant.underratedScore >= 0.12;
      case "fancy":
        return restaurant.adjustedRating >= 4.2 && restaurant.reliabilityScore >= 0.35 && restaurant.priceRange >= 900;
      case "experimental":
        return restaurant.underratedScore >= 0.16 && restaurant.popularity <= 0.42;
      case "indulgent":
        return restaurant.popularity >= 0.55 || restaurant.hypeScore >= 0.12;
      default:
        return true;
    }
  }

  function buildExplanation(input) {
    if (input.tag === "overhyped") {
      if (input.reliabilityScore >= 0.35) return `Highly visible, but the adjusted quality settles near ${input.adjustedRating.toFixed(1)} so the popularity looks inflated.`;
      return `Strong social attention is outpacing the quality signal here.`;
    }
    if (input.tag === "hidden-gem") {
      if (input.reliabilityScore >= 0.28) return `Exceptional adjusted quality despite limited visibility makes this feel like a real hidden gem.`;
      return `Strong quality with limited mainstream attention gives this real discovery potential.`;
    }
    if (input.reliabilityScore >= 0.5) return `The adjusted score stays steady across many reviews, which makes this a dependable choice.`;
    return `Balanced visibility, quality, and confidence keep this in the worth-it zone.`;
  }

  function renderScoreBar(label, value, tone) {
    return `
      <div class="score-item">
        <div class="score-label-row">
          <span>${label}</span>
          <span>${Math.round(value * 100)}</span>
        </div>
        <div class="score-track"><div class="score-fill ${tone}" style="width:${Math.max(4, value * 100)}%"></div></div>
      </div>
    `;
  }

  function renderScoreBlock(label, value, tone) {
    return `
      <div class="detail-panel">
        <strong>${escapeHtml(label)}</strong>
        ${renderScoreBar(label, value, tone)}
      </div>
    `;
  }

  function renderEmptyState(text) {
    return `<div class="empty-state">${escapeHtml(text)}</div>`;
  }

  function syncExploreUrl() {
    if (PAGE !== "explore") return;
    const params = new URLSearchParams();
    if (state.filters.search) params.set("q", state.filters.search);
    if (state.filters.mood) params.set("mood", state.filters.mood);
    if (state.filters.tag) params.set("tag", state.filters.tag);
    if (state.filters.area) params.set("area", state.filters.area);
    if (state.filters.cuisine) params.set("cuisine", state.filters.cuisine);
    if (state.filters.budget) params.set("budget", state.filters.budget);
    if (state.filters.rating) params.set("rating", state.filters.rating);
    if (state.filters.sort && state.filters.sort !== "recommended") params.set("sort", state.filters.sort);
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", next);
  }

  function buildExploreUrl(params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value) searchParams.set(key, value);
    });
    return `explore.html${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  }

  function buildMapUrlForRestaurant(restaurant) {
    return `map.html?area=${encodeURIComponent(restaurant.area)}&q=${encodeURIComponent(restaurant.name)}`;
  }

  function buildRestaurantUrl(id) {
    return `restaurant.html?id=${encodeURIComponent(id)}`;
  }

  function navigate(url) {
    window.location.href = url;
  }

  function normalizeSubmissionRecord(record) {
    return {
      ...record,
      area: normalizeAreaForClient(record.area || ""),
      cuisine: String(record.cuisine || "").trim(),
      cuisines: Array.isArray(record.cuisines)
        ? record.cuisines
        : String(record.cuisine || "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
      searchText: [record.name, record.area, record.cuisine, record.description].filter(Boolean).join(" ").toLowerCase(),
    };
  }

  function normalizeAreaForClient(value) {
    const area = String(value || "").trim();
    if (!area) return "Unknown Area";
    if (/^koramangala/i.test(area)) return "Koramangala";
    if (/^hsr$/i.test(area)) return "HSR Layout";
    if (/^jp nagar/i.test(area)) return "JP Nagar";
    if (/^new bel road/i.test(area)) return "New BEL Road";
    if (/^mg road/i.test(area)) return "MG Road";
    return area;
  }

  function deriveCategory(type, cuisine) {
    const text = `${type || ""} ${cuisine || ""}`.toLowerCase();
    if (/(dessert|ice cream|sweet|mithai|waffle)/.test(text)) return "dessert";
    if (/(cafe|coffee|bakery|beverage)/.test(text)) return "cafe";
    if (/(bar|pub|brew|lounge)/.test(text)) return "bar";
    return "restaurant";
  }

  function deriveMoodTags(input) {
    const tags = [];
    if (input.hypeScore <= 0.18 && input.reliabilityScore >= 0.3) tags.push("chill");
    if (input.priceRange && input.priceRange <= 500 && input.underratedScore >= 0.12) tags.push("budget");
    if (input.adjustedRating >= 4.2 && input.reliabilityScore >= 0.35 && input.priceRange >= 900) tags.push("fancy");
    if (input.underratedScore >= 0.16 && input.popularity <= 0.42) tags.push("experimental");
    if (input.popularity >= 0.55 || input.hypeScore >= 0.12) tags.push("indulgent");
    return tags;
  }

  function getPlannerCandidateScore(previous, restaurant, hopLimit) {
    const base = restaurant.recommendationScore + restaurant.adjustedRating * 0.14;
    if (!previous || !previous.hasMapPoint || !restaurant.hasMapPoint) return base;
    const distance = haversineKm(previous, restaurant);
    const distanceScore = Math.max(0, hopLimit - distance) * 0.2;
    const cuisinePenalty = previous.cuisine === restaurant.cuisine ? 0.3 : 0;
    return base + distanceScore - cuisinePenalty;
  }

  function isCafeLike(restaurant) {
    return /(cafe|bakery|coffee|beverage|dessert parlor)/i.test(`${restaurant.restaurantType} ${restaurant.cuisine}`);
  }

  function isDessertLike(restaurant) {
    return /(dessert|ice cream|waffle|mithai|sweet|bakery|shake|juice)/i.test(`${restaurant.restaurantType} ${restaurant.cuisine}`);
  }

  function isLunchLike(restaurant) {
    return !isDessertLike(restaurant) && /(casual|quick bites|mess|biryani|south indian|north indian|meal|thali|restaurant)/i.test(`${restaurant.restaurantType} ${restaurant.cuisine} ${restaurant.mealType}`);
  }

  function isDinnerLike(restaurant) {
    return !isDessertLike(restaurant) && /(fine dining|casual|bar|pub|grill|asian|continental|north indian|biryani|restaurant)/i.test(`${restaurant.restaurantType} ${restaurant.cuisine}`);
  }

  function getSimilarityScore(base, candidate) {
    let score = 0;
    if (base.area === candidate.area) score += 1.2;
    if (base.category === candidate.category) score += 0.9;
    const sharedCuisines = base.cuisines.filter((cuisine) => candidate.cuisines.includes(cuisine)).length;
    score += sharedCuisines * 0.55;
    if (base.tag === candidate.tag) score += 0.45;
    return score;
  }

  function toggleFavorite(restaurantId) {
    if (!state.currentUser) {
      showToast("Sign in to save favourites.");
      navigate("sign-in.html");
      return;
    }
    const email = state.currentUser.email;
    const next = new Set(getFavoriteIds());
    if (next.has(restaurantId)) {
      next.delete(restaurantId);
      showToast("Removed from favourites.");
    } else {
      next.add(restaurantId);
      showToast("Saved to favourites.");
    }
    state.favorites[email] = [...next];
    saveJson(STORAGE_KEYS.favorites, state.favorites);
    if (PAGE === "restaurant") {
      initRestaurantPage();
    }
    renderProfileState();
  }

  function getFavoriteIds() {
    if (!state.currentUser) return [];
    return state.favorites[state.currentUser.email] || [];
  }

  function getAreaCentroid(area) {
    const matches = state.restaurants.filter((restaurant) => restaurant.area === area && restaurant.hasMapPoint);
    if (!matches.length) return null;
    return {
      lat: average(matches.map((item) => item.lat)),
      lng: average(matches.map((item) => item.lng)),
    };
  }

  function restaurantToFeature(restaurant) {
    return {
      type: "Feature",
      id: restaurant.id,
      properties: {
        id: restaurant.id,
        name: restaurant.name,
        area: restaurant.area,
        tag: restaurant.tag,
        tagLabel: restaurant.tagLabel,
        rating: restaurant.rating,
        reviewCount: restaurant.reviewCount,
      },
      geometry: { type: "Point", coordinates: [restaurant.lng, restaurant.lat] },
    };
  }

  function emptyFeatureCollection() {
    return { type: "FeatureCollection", features: [] };
  }

  function scrollCardIntoView(id) {
    const card = document.querySelector(`[data-restaurant-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  const sorters = {
    recommended: (left, right) => right.recommendationScore - left.recommendationScore || right.rating - left.rating || right.reviewCount - left.reviewCount,
    rating: (left, right) => right.adjustedRating - left.adjustedRating || right.rating - left.rating || right.reviewCount - left.reviewCount,
    reviews: (left, right) => right.reviewCount - left.reviewCount || right.rating - left.rating,
    underrated: (left, right) => right.underratedScore - left.underratedScore || right.rating - left.rating,
    hype: (left, right) => right.hypeScore - left.hypeScore || right.reviewCount - left.reviewCount,
    "price-low": (left, right) => (left.priceRange || Infinity) - (right.priceRange || Infinity),
    "price-high": (left, right) => (right.priceRange || 0) - (left.priceRange || 0),
  };

  function validateAuth(values, isSignup) {
    if (window.zod) {
      const schema = isSignup
        ? window.zod.object({
            displayName: window.zod.string().min(2).max(40),
            email: window.zod.string().email(),
            password: window.zod.string().min(6),
          })
        : window.zod.object({
            email: window.zod.string().email(),
            password: window.zod.string().min(6),
          });
      const result = schema.safeParse(values);
      if (!result.success) {
        return { ok: false, message: "Please check the form values and try again." };
      }
      return { ok: true };
    }
    if (isSignup && (!values.displayName || values.displayName.length < 2)) return { ok: false, message: "Display name must be at least 2 characters." };
    if (!values.email || !values.email.includes("@")) return { ok: false, message: "Enter a valid email address." };
    if (!values.password || values.password.length < 6) return { ok: false, message: "Password must be at least 6 characters." };
    return { ok: true };
  }

  function getBudgetBucket(priceRange) {
    if (!priceRange) return "";
    if (priceRange <= 500) return "budget";
    if (priceRange <= 1200) return "mid";
    return "premium";
  }

  function getMoodLabel(id) {
    return MOODS.find((mood) => mood.id === id)?.label || id;
  }

  function highlightText(text, query) {
    const raw = String(text || "");
    const tokens = getSearchTokens(query).filter((token) => token.length > 1);
    if (!tokens.length) return escapeHtml(raw);
    const pattern = new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "ig");
    return raw
      .split(pattern)
      .map((part) => (tokens.some((token) => part.toLowerCase() === token.toLowerCase()) ? `<mark class="search-hit">${escapeHtml(part)}</mark>` : escapeHtml(part)))
      .join("");
  }

  function getSearchTokens(query) {
    return String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  function formatCurrency(value) {
    return `₹${Number(value || 0).toLocaleString("en-IN")}`;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-IN");
  }

  function formatDistance(value) {
    return `${Number(value || 0).toFixed(1)} km`;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown date";
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function toTitleCase(value) {
    return String(value || "")
      .split(/[\s-]+/)
      .map((word) => word ? word[0].toUpperCase() + word.slice(1) : word)
      .join(" ");
  }

  function loadJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) {
      element.textContent = value;
    }
  }

  function setInputValue(id, value) {
    const element = byId(id);
    if (element) element.value = value;
  }

  function hydrateSelect(id, value) {
    const element = byId(id);
    if (element) element.value = value || "";
  }

  function showToast(message) {
    const stack = byId("toast-stack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    stack.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function groupBy(items, key) {
    const grouped = new Map();
    items.forEach((item) => {
      const value = item[key];
      if (!grouped.has(value)) grouped.set(value, []);
      grouped.get(value).push(item);
    });
    return grouped;
  }

  function countUnique(values) {
    return new Set(values.filter(Boolean)).size;
  }

  function haversineKm(left, right) {
    if (!left || !right || !Number.isFinite(left.lat) || !Number.isFinite(left.lng) || !Number.isFinite(right.lat) || !Number.isFinite(right.lng)) return Infinity;
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const dLat = toRadians(right.lat - left.lat);
    const dLng = toRadians(right.lng - left.lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(left.lat)) * Math.cos(toRadians(right.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function shuffleBySeed(items, seed) {
    const copy = [...items];
    let currentSeed = seed + 1;
    for (let index = copy.length - 1; index > 0; index -= 1) {
      currentSeed = (currentSeed * 9301 + 49297) % 233280;
      const swapIndex = Math.floor((currentSeed / 233280) * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function percentile(values, ratio) {
    if (!values.length) return 1;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
    return sorted[index] || 1;
  }

  function debounce(callback, wait) {
    let timeoutId = null;
    return (...args) => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => callback(...args), wait);
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
