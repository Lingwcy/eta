import { homedir } from "node:os";
import { SkillsService as CoreSkillsService } from "@eta/core/service/skills/index";

export class SkillsService extends CoreSkillsService {
  static override readonly layerWith = (home = homedir()) => CoreSkillsService.layerWith(home);
  static readonly layer = SkillsService.layerWith();
}
