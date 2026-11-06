/** Storage accessors can throw before a guarded getItem/setItem call even begins. */
export function browserStorage(
  area: "localStorage" | "sessionStorage",
): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: (key) => window[area].getItem(key),
    setItem: (key, value) => window[area].setItem(key, value),
  };
}
