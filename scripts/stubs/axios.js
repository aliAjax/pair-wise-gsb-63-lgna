// Node 端流程校验用的 axios 空实现（应用本身不在 Node 发请求）
const axiosStub = {
  create: () => ({
    get: async () => ({ data: [] })
  })
}
export default axiosStub
export const create = axiosStub.create
