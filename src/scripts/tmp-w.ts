import { parseWeight } from "../core/stores/weight.js";
for (const s of ["300 GR.", "33 CL.", "1080 GR.", "1,5 KG", "2 DL.", "500ml", "1.5kg", "6 x 250ml", "450 gm", "2 large"])
	console.log(String(s).padEnd(12), JSON.stringify(parseWeight(s)));
