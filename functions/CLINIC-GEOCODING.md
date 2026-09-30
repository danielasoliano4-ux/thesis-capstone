# Clinic approval geocoding

Uses Nominatim. No API key is needed for its public endpoint. Review https://operations.osmfoundation.org/policies/nominatim/ before deployment: maximum 1 request/second across the app, identifying User-Agent, caching and OpenStreetMap attribution. Only admin-triggered clinic approval performs a lookup; there is no autocomplete or bulk lookup.

Registration saves clinic_address and clinic_barangay. The admin reviews both. reviewClinicRegistration checks administrator access, looks up the saved address and atomically creates the clinic and approves staff. Pending accounts cannot sign in. Denial does not contact Nominatim. Repeated successful approval does not repeat geocoding. Staff cannot overwrite coordinates.

Lookup is serialized with one function instance/concurrency, a shared transaction lock, a 1.1-second cooldown, and a 30-day result cache. Private configuration document _geocoding_config/nominatim may set endpoint to another HTTPS Nominatim /search URL without software changes. Cache and lock collections are not browser accessible. Optionally configure TTL on _geocoding_cache.expiresAt.

A single building/clinic-level OSM match in Cabuyao and the selected barangay is required. Missing, coarse, ambiguous or failed results leave the account pending. Coordinates depend on OSM coverage; precise locations cannot be guaranteed for unmapped addresses. Older pending registrations missing clinic_barangay require administrator correction.

Deploy functions, firestore:rules and hosting together. The existing clinic snapshot listener adds the new marker automatically. Test a real clinic address after deployment. No production lookups or deployment were performed by the local tests.
