import { describe, expect, it } from "vitest";
import { resolvePhotonModule } from "../src/utils/photon.ts";

describe("resolvePhotonModule", () => {
	it("accepts the direct CommonJS export shape", () => {
		const photon = { PhotonImage: class PhotonImage {} };

		expect(resolvePhotonModule(photon)).toBe(photon);
	});

	it("unwraps the default export shape produced by split ESM bundles", () => {
		const photon = { PhotonImage: class PhotonImage {} };

		expect(resolvePhotonModule({ default: photon })).toBe(photon);
	});

	it("rejects module namespaces without PhotonImage", () => {
		expect(resolvePhotonModule({ default: {} })).toBeNull();
	});
});
