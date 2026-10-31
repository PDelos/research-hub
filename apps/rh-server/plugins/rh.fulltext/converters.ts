// The Converter slot (spec full-text; design v1-6 D3): the enabled converters, which one is active, and converting a
// PDF with the active one or a named one.
import type { Section } from "../../src/fulltext/parse.ts";
import type { hostOf } from "../../src/kernel/builtin.ts";
import type { ConverterExports, ConverterView } from "./main.ts";

export class FullTextInvalid extends Error {}

export class Converters {
  constructor(
    private readonly host: ReturnType<typeof hostOf>,
    private readonly settings: () => Readonly<Record<string, unknown>>,
  ) {}

  private get contributions() {
    return this.host.services.contributions;
  }

  /** Every converter with whether it can run here and why not. */
  async views(): Promise<ConverterView[]> {
    const all = await this.contributions.contributionsTo("fulltext.converter", { activate: true });
    const active = this.contributions.activeContribution("fulltext.converter", this.settings());
    return Promise.all(
      all.map(async (contribution) => {
        let availability: { ok: boolean; reason?: string } = { ok: false, reason: "not loaded" };
        try {
          availability = (await this.host.exportsOf<ConverterExports>(contribution.pluginId)).available();
        } catch (error) {
          availability = { ok: false, reason: String(error) };
        }
        return {
          id: contribution.id,
          title: String(contribution.title ?? contribution.id),
          pluginId: contribution.pluginId,
          active: contribution.id === active?.id,
          available: availability.ok,
          ...(availability.reason ? { reason: availability.reason } : {}),
        };
      }),
    );
  }

  async convert(pdf: Uint8Array, converterId?: string): Promise<Section[]> {
    await this.contributions.contributionsTo("fulltext.converter", { activate: true });
    const choice = converterId
      ? (await this.contributions.contributionsTo("fulltext.converter")).find((c) => c.id === converterId)
      : this.contributions.activeContribution("fulltext.converter", this.settings());
    if (!choice) throw new FullTextInvalid(converterId ? `no converter ${converterId}` : "no converter is enabled");
    const converter = await this.host.exportsOf<ConverterExports>(choice.pluginId);
    const availability = converter.available();
    if (!availability.ok)
      throw new FullTextInvalid(`${choice.id} is not available: ${availability.reason ?? "unknown"}`);
    return converter.convert(pdf);
  }
}
