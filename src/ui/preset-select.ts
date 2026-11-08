import { MODEM_PRESET_NAMES, type ModemPresetName } from '../airtime';

export function fillPresetSelect(sel: HTMLSelectElement, value: ModemPresetName) {
  sel.replaceChildren(
    ...MODEM_PRESET_NAMES.map((n) => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      return o;
    }),
  );
  sel.value = value;
}
