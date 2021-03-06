import { BaseBotModule, BotModuleInitContext, BotMessageType, BotModule } from '../interface'
import { BotMessageEvent, BotRequestEvent, BotRequestType, BotRequestSubType, isBotMessageEvent, AnyFilter } from '../tsbot'
import { BotStorage } from '../storage'

const RequestTimeout = 30 * 60 * 1000 // 30min
const RequestTimeoutStr = '30分钟'

interface PendingRequest {
  expireAt: number
  onApprove: Function
  raw: string
}
type ExcludeExpireAt<T> = {
  [P in Exclude<keyof T, 'expireAt'>]: T[P];
}

export class AdminControl extends BaseBotModule {
  id = 'admin_control'
  name = '管理模块'
  adminQQ: number[] = []
  requestMap: Map<number, PendingRequest> = new Map()
  enableStorage!: BotStorage<Record<number, boolean | undefined>>

  init (ctx: BotModuleInitContext) {
    super.init(ctx)
    const { bot, bus, storage } = ctx
  
    this.enableStorage = storage.getChild('enable')
    bus.bus.globalFilters.push(this.globalFilter)
    bus.registerMessage([bus.privateFilter, this.adminFilter], e => this.onAdmin(e))
    bus.registerMessage([bus.privateFilter], e => this.onPrivate(e))
    bus.registerRequest([this.groupInviteFilter], e => this.onInvite(e))
  }

  onInvite (e: BotRequestEvent) {
    console.log('request.group.invite', e)
    let { flag, subType, userId, groupId, selfId } = e

    this.generateRequest({
      onApprove: () => {
        this.bot.send('set_group_add_request', {
          flag,
          sub_type: subType,
          approve: true
        })
      },
      raw: JSON.stringify(e)
    }, `QQ: ${userId} 邀请 ${selfId} 进群 ${groupId}`)
  }
  onAdmin (e: BotMessageEvent): void | string {
    let { message } = e
    if (message === 'exit') {
      return this.bot.exit()
    }
    if (message.startsWith('同意')) {
      let id = parseInt(message.substring(2))
      let res = this.requestMap.get(id)
      console.log('shit', id, res)
      if (res) {
        this.requestMap.delete(id)
        if (res.expireAt < Date.now()) {
          return '该请求已超时'
        } else {
          res.onApprove()
          return '已接受'
        }
      } else {
        return '未找到ID, 可能已经同意或超时'
      }
    }
  }
  async isAdmin (groupId: number, userId: number) {
    if (this.adminQQ.includes(userId)) {
      return true
    }
    let r: any = await this.bot.send('get_group_member_info', {
      group_id: groupId,
      user_id: userId
    })
    if (r.retcode === 0) {
      const role = r.data.role
      const isAdmin = role === 'owner' || role === 'admin'

      return isAdmin
    } else {
      throw new Error('获取群信息失败, 请检查群号码')
    }
  }
  async onPrivate (e: BotMessageEvent) {
    try {
      let { message, userId } = e

      if (message.startsWith('列出模块')) {
        message = message.substr(4)
        let groupId = parseInt(message.trim())
        let out: string[] = ['ID  名称  是否开启']
        for (let m of this.bot.getModules()) {
          out.push(`${m.id}  ${m.name}  ${this.isModuleEnabled(groupId, m)}`)
        }
        return out.join('\n')
      } else if (message.startsWith('关闭模块') || message.startsWith('开启模块')) {
        let val = message.startsWith('开启模块')
        message = message.substr(4)
        let args = message.split(' ').filter(i => i.length > 0)
        let groupId = parseInt(args[0])
        let mid = args[1]
        if (await this.isAdmin(groupId, userId)) {
          let dict = this.enableStorage.get(mid)
          if (dict === undefined) {
            dict = {}
          }
          dict[groupId] = val
          this.enableStorage.set(mid, dict)
          return `${val ? '开启' : '关闭'} ${mid} 成功`
        } else {
          return '你没有权限(该群管理员权限)'
        }
      }
    } catch (e) {
      console.error('err', e)
    }
  }

  sendToAdmin (message: string) {
    for (let qq of this.adminQQ) {
      this.bot.sendPrivateMessage(qq, message)
    }
  }

  generateRequest (callbacks: ExcludeExpireAt<PendingRequest>, description: string) {
    const requestMap = this.requestMap
    let req = {
      ...callbacks,
      expireAt: Date.now() + RequestTimeout
    }
    let id: number = -1
    for (let i = 1; i < Infinity; i++) {
      if (!requestMap.has(i)) {
        id = i
        requestMap.set(i, req)
        break
      }
    }
    this.sendToAdmin(`${description} 回复 "同意${id}" 接受邀请, ${RequestTimeoutStr}超时`)
  }

  isModuleEnabled (groupId: number, m: BotModule) {
    let dict = this.enableStorage.get(m.id)
    let ret: boolean | undefined
    if (dict === undefined) {
      ret = m.defaultEnable
    } else {
      ret = dict[groupId]
      if (ret === undefined) {
        ret = m.defaultEnable
      }
    }
    return ret
  }
  globalFilter: AnyFilter = (e, { module: m }) => {
    if (isBotMessageEvent(e)) {
      if (e.messageType === BotMessageType.Group) {
        let r = this.isModuleEnabled(e.groupId!, m)
        return r
      }
    }
    return true
  }
  adminFilter = (e: BotMessageEvent) => {
    return this.adminQQ.includes(e.userId)
  }
  groupInviteFilter (e: BotRequestEvent) {
    return ((e.requestType === BotRequestType.Group) && (e.subType === BotRequestSubType.Invite))
  }
  help (e: BotMessageEvent) {
    if (e.messageType === BotMessageType.Private) {
      return `直接邀请机器人进群, 经过管理员审核后会加入.
以 '*' 开头的指令需要该群管理员权限 输入以下指令进行管理(不需输入花括号):
  列出模块 {QQ群号}
* 关闭模块 {QQ群号} {模块ID}
* 开启模块 {QQ群号} {模块ID}`
    } else {
      return ''
    }
  }
}
