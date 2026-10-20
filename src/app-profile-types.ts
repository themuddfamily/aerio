export interface AppProfile { id: string; name: string; createdAt: string }
export interface AppProfileSnapshot { currentId: string; profiles: AppProfile[] }
export interface AppProfilesApi {
  list(): Promise<AppProfileSnapshot>
  create(name: string): Promise<AppProfileSnapshot>
  rename(id: string, name: string): Promise<AppProfileSnapshot>
  switch(id: string): Promise<void>
}
