/**
 * The vocabularies this deployment knows by id (the SKOS profile knows none itself). Add a host here and to
 * VOCAB_ALLOWED_DOMAINS in wrangler.toml together.
 */
import type { InstanceEntry } from "@ondata-extended/profile-contract";
import type { VocabExt } from "@ondata-extended/profile-skos";

/** This deployment's sentence for the server instructions: what its vocabulary is for. */
export const INSTRUCTIONS =
  "Svada is a Swedish vocabulary of terms and concepts for the SVADA project. In work on SVADA, check terms against it " +
  "and use its preferred terms.";

export const VOCABULARIES: InstanceEntry<VocabExt>[] = [
  {
    id: "svada",
    baseUrl: "https://begrepp.hagstrom.nu/",
    ext: { adapter: "tematres", defaultLang: "sv", title: "Svada - termer och begrepp", conceptUriBase: "https://begrepp.hagstrom.nu/skos/", snapshotUrl: "https://begrepp.hagstrom.nu/dumps/svada.ndjson" }
  }
];
