export enum LCUEvents {
  EndOfGameStats = "OnJsonApiEvent_lol-end-of-game_v1_eog-stats-block",
  ChampSelectSession = "OnJsonApiEvent_lol-champ-select_v1_session",
  GameSession = "OnJsonApiEvent_lol-gameflow_v1_session",
  CrowdFavoriteChampionList = "OnJsonApiEvent_lol-lobby-team-builder_champ-select_v1_crowd-favorte-champion-list",
}

export type LCUEventMessage =
  | {
      type: LCUEvents.ChampSelectSession
      data: ChampSelectSessionEvent
    }
  | {
      type: LCUEvents.GameSession
      data: GameSessionEvent
    }
  | {
      type: LCUEvents.EndOfGameStats
      data: any
    }
  | {
      type: LCUEvents.CrowdFavoriteChampionList
      data: number[]
    }

export interface ChampSelectSessionEvent {
  actions: {
    type: string
    actorCellId: number
    championId: number
    isAllyAction: boolean
  }[][]
  localPlayerCellId: number
  benchChampions?: {
    championId: number
    isPriority: boolean
  }[]
  benchEnabled?: boolean
}

export interface PlayerChampionSelection {
  championId: number
  puuid: string
}

export interface GameSessionEvent {
  gameData: {
    gameId: number
    playerChampionSelections: PlayerChampionSelection[]
    queue?: {
      gameMode?: string
    }
    gameMode?: string
  }
  phase: string
}
