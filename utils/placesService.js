const axios = require('axios');

function normalizePlace(result) {
  if (!result) return null;
  return {
    place_id: result.place_id,
    name: result.name,
    rating: result.rating,
    geometry: {
      location: {
        lat: result.geometry?.location?.lat,
        lng: result.geometry?.location?.lng,
      },
    },
  };
}

// Returns the highest-rated place for the given keyword within radius, or null
async function nearbyBestPlaceByKeyword({ lat, lng, radius = 500, keyword }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not configured');
  const params = new URLSearchParams({
    key,
    location: `${lat},${lng}`,
    radius: String(radius || 500),
    keyword: String(keyword || '').slice(0, 64),
    opennow: 'true',
  });
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`;
  const resp = await axios.get(url, { timeout: 10000 });
  if (resp.status !== 200) throw new Error(`Places error ${resp.status}`);
  const results = Array.isArray(resp.data?.results) ? resp.data.results : [];
  if (!results.length) return null;
  const sorted = results
    .map(normalizePlace)
    .filter(Boolean)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return sorted[0] || null;
}

module.exports = { nearbyBestPlaceByKeyword };
