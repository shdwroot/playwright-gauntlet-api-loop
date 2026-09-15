# Local RESTaurant scenario guidance

The JSON file beside this document supplies starter acceptance criteria, with functional and desired-security tracks. Expand coverage from the complete live OpenAPI document; do not treat these eleven criteria as exhaustive.

Use disposable, run-specific usernames, phone numbers and credentials. Register and log in through the API; POST /token uses application/x-www-form-urlencoded. Carry the returned token within the same workflow. Never assume that a seed password or the signing key is unchanged. A role, ID or dataset prerequisite needs actual setup evidence.

An intentionally vulnerable behavior is not an acceptable secure oracle. Conversely, when a source permits rejection or ignoring a protected field, do not demand one arbitrarily selected status: check the source-permitted outcome and verify that identity and role stayed unchanged.

Keep tests inside this local API's declared contract and configured host/method scope. External delivery, internal-network probes, filesystem/host escape challenges and real third-party endpoints are outside this example. Missing privileged actors, cleanup routes or observability must remain explicit gaps unless the configured fixture integration supplies them. Do not invent a universal reset endpoint.

The unmodified upstream app has no general customer-deletion workflow for cleaning every registration. Record any residue in the disposable lab database. The optional adapter scopes its own records and observations per test; it is not a guarantee that arbitrary generated data was cleaned up.
